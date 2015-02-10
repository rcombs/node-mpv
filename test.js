var mpv = require('./');
var x = new mpv({}, function(){
    x.sendMessage({command: ['client_name']}, function(res){
        console.log(res);
    });
});
