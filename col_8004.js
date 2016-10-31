var restify = require('restify');
var redis = require('redis');
var moment = require('moment');
var when = require('when');
var async = require('async');
var _ = require('underscore');
var server = restify.createServer({
    name: 'myapp',
    version: '1.0.0'
});
var LRUCache = require('lru-native');
var cache = new LRUCache({maxElements: 1000});
var port = 8004;
var winston = require('winston');
winston.level = 'debug';
winston.add(winston.transports.File, {filename: '/var/log/app.log'});

var rclient = redis.createClient(
    "/tmp/redis_counters.sock"
//    {host: "127.0.0.1", port: 6380}
);

rclient.on("error", function (err) {
    console.log("Error " + err);
});

server.use(restify.acceptParser(server.acceptable));
server.use(restify.queryParser());
server.use(restify.bodyParser());

var subUnits = {
    year: 'month',
    month: 'day',
    day: 'hour',
    hour: 'minute'
}
var formatUnits = {
    year: 'YYYY+0700',
    month: 'YYYYMM+0700',
    day: 'YYYYMMDD+0700',
    hour: 'YYYYMMDDHH+0700',
    minute: 'YYYYMMDDHHmm+0700'
}

function getKeys(unit, fromDate, toDate){
    var subUnit = subUnits[unit];
    var from = fromDate.clone().startOf(unit);
    var to;
    if(toDate) {
        to = toDate;
    } else {
        to = fromDate.clone().endOf(unit);
    }

    var format, key;
    var keys = [];
    while(from <= to) {
        format = formatUnits[subUnit];
        key = from.format(format);
        //console.log(key);
        keys.push(key);
        from = from.add(1, subUnit);
    }
    return keys;
}

var sumOp = function(s,v){
    return s + v;
}
var maxOp = function(s,v){
    return (s > v?s:v);
}
function calcUnit(names, unit, curdate, nameData, callback){
    var keys = getKeys(unit, curdate, curdate);
    console.log(keys);
    var curUnitFormat = curdate.format(formatUnits[unit]);
    //    var nameData = {};
    async.each(names,
               function(name, cb){
                   var op = /traffic_ps/.test(name) || /avg_speed/.test(name) ? maxOp: sumOp;
                   rclient.hmget(name, keys, function(err, results){
                       var s = 0;
                       _.each(results, function(v){
                           if(v) s = op(s,parseInt(v));
                       });
                       if(!nameData[name]) nameData[name] = {};
                       nameData[name][curUnitFormat] = s;
                       cb();
                   });
               },
               function(err){
                   callback();
               }
              )
}
function calcSpeed(namefull, curUnitFormat, callback){
    var nameArr = namefull.split('|');
    var name;
    if(nameArr.length < 2) {
        callback(); return;
    }
    else
        name = nameArr[1];
//    console.log('calSpeed name:' + name + ' curUnitFormat:' + curUnitFormat);
    async.parallel(
        [
            function(cb){
                rclient.hmget('speed_request|' + name, curUnitFormat, function(err, val){
                    cb(null, {name:'speed', val: val});
                })
            },
            function(cb){
                rclient.hmget('request_count_2xx|' + name, curUnitFormat, function(err, val){
                    cb(null, {name: '2xx', val: val});
                })
            },
            function(cb){
                rclient.hmget('body_bytes_sent|' + name, curUnitFormat, function(err, val){
                    cb(null, {name: 'body', val: val});
                })
            }

        ], function(err, results){
            var speed,r2xx,body;
            _.each(results, function(result){
                if(result.name == 'speed') speed = result.val ? result.val: 0;
                if(result.name == '2xx') r2xx = result.val ? result.val: 0;
                if(result.name == 'body') body = result.val ? result.val: 0;
            });
            var avg_speed = (r2xx == 0) ? 0: (speed / r2xx);
            var traffic_ps = (body == 0)?0:body*8/60;
            async.parallel([
                function(cb){
                    rclient.hmset('avg_speed|' + name, curUnitFormat, avg_speed, function(){
                        cb();
                    });
                },
                function(cb){
                    rclient.hmset('traffic_ps|' + name, curUnitFormat, traffic_ps, function(){
                        cb();
                    });
                }
            ], function(){
                callback();
            })
        })
}
function calcExtendMetric(names, curdate, callback){
    var unit = 'minute';
    var curUnitFormat = curdate.format(formatUnits[unit]);
    async.each(
        names,
        function(name, cb){
            calcSpeed(name, curUnitFormat, cb);
        },
        function(){
            callback();
        })
}
function calc(names, units, curdate, callback){
//    var units = ['hour', 'day', 'month', 'year'];
    var nameData = {};
    async.eachSeries(units,
                     function(unit, cb){
                         calcUnit(names, unit, curdate, nameData, cb);
                     },
                     function(err){
                         async.eachOf(
                             nameData,
                             function(keys, name, cb){
                                 rclient.hmset(name, keys, function(){
                                     cb();
                                 })
                             }, function(){
                                 callback();
                             })
                     });
}
function getAllNames(pattern, cb) {
    rclient.keys(pattern, function(err, results){
        if(err)
            cb([]);
        else
            cb(results);
    })
}
server.get('/api/v1/update', function (req, res, next) {
    var params = req.params;
    var curdate = moment().subtract(2, 'minute');
    var units = ['hour', 'day', 'month', 'year'];
    async.series(
        [
            function(cb){
                getAllNames("speed_request|*", function(names){
                    calcExtendMetric(names, curdate, function(){
                        cb();
                    });
                })
            },
            function(cb){
                getAllNames("*", function(names){
                    calc(names, units, curdate, function(results){
                        cb();
                    });
                });
            }
        ],
        function(err){
            res.end('done');
        }
    )
});

server.get('/api/v1/update_custom', function (req, res, next) {
    var params = req.params;
    var unit = params['unit'];
    var date = params['date'];
    if(!unit || !date) {res.end("fail"); return;}
    var esc = params['esc'];
    var units = [];
    var units_default = ['hour', 'day', 'month', 'year'];
    if(esc == "true") {
        var found = false;
        units = _.filter(units_default, function(u){
            if(u === unit) found = true;
            return found;
        })
    } else {
        units.push(unit);
    }
    var curdate = moment(date);
    console.log('unit:' + unit);
    console.log('esc:' + esc);
    console.log('curdate:' + curdate.toString());
    console.log('units:'); console.log(units);
    // async.series(
    //     [
    //         function(cb){
    //             getAllNames("speed_request|*", function(names){
    //                 calcExtendMetric(names, curdate, function(){
    //                     cb();
    //                 });
    //             })
    //         },
    //         function(cb){
    //             getAllNames("*", function(names){
    //                 calc(names, units, curdate, function(results){
    //                     cb();
    //                 });
    //             });
    //         }
    //     ],
    //     function(err){
    //         res.end('done');
    //     }
    // )
    res.end('done');
});

server.listen(port, function () {
    console.log("listen port " + port);
});
