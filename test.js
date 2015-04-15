var mpv = require('./');
var x = new mpv({'mpvArgs': ['--fs', '--force-window', '--no-osc']}, function(){
    x.sendMessage({command: ['client_name']}, function(res){
        console.log(res);
    });
});
