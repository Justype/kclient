// LinuxServer KasmVNC Client

//// Env variables ////
var CUSTOM_USER = process.env.CUSTOM_USER || 'abc';
var PASSWORD = process.env.PASSWORD || 'abc';
var SUBFOLDER = process.env.SUBFOLDER || '/';
var TITLE = process.env.TITLE || 'KasmVNC Client';
var FM_HOME = process.env.FM_HOME || '/config';
var LISTEN_PORT = parseInt(process.env.LISTEN_PORT) || 6900;
var KASM_WS_PORT = parseInt(process.env.KASM_WS_PORT) || 6901;
var PATH;
if (SUBFOLDER != '/') {
  PATH = '&path=' + SUBFOLDER.substring(1) + 'websockify'
} else {
  PATH = false;
}
//// Application Variables ////
var socketIO = require('socket.io');
var express = require('express');
var ejs = require('ejs');
var app = require('express')();
var http = require('http').Server(app);
var bodyParser = require('body-parser');

// Intercept /websockify WebSocket upgrades BEFORE Socket.IO attaches.
// Socket.IO calls socket.destroy() on any upgrade request that doesn't match
// its own path, so we must handle /websockify before Socket.IO ever sees it.
(function() {
  var _net = require('net');
  var _origEmit = http.emit.bind(http);
  http.emit = function(event, req, socket, head) {
    if (event === 'upgrade' && req && req.url && req.url.includes('websockify')) {
      console.log('[kclient] websockify upgrade intercepted, forwarding to KasmVNC port', KASM_WS_PORT);
      var bk = _net.connect(KASM_WS_PORT, '127.0.0.1');
      bk.on('connect', function() {
        console.log('[kclient] connected to KasmVNC, forwarding request');
        var h = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
        for (var i = 0; i < req.rawHeaders.length; i += 2) {
          h += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
        }
        h += '\r\n';
        bk.write(h);
        if (head && head.length) bk.write(head);
        bk.pipe(socket);
        socket.pipe(bk);
      });
      bk.on('error', function(err) { console.error('[kclient] KasmVNC connect error:', err.message); socket.destroy(); });
      socket.on('error', function(err) { console.error('[kclient] socket error:', err.message); bk.destroy(); });
      return;
    }
    return _origEmit(event, req, socket, head);
  };
})();
var baseRouter = express.Router();
var fsw = require('fs').promises;
var fs = require('fs');
// Audio init
var audioEnabled = true;
var PulseAudio = require('pulseaudio2');
var pulse = new PulseAudio();
pulse.on('error', function(error) {
  console.log(error);
  audioEnabled = false;
  console.log('Kclient was unable to init audio, it is possible your host lacks support!!!!');
});


//// Server Paths Main ////
app.engine('html', require('ejs').renderFile);
app.engine('json', require('ejs').renderFile);
baseRouter.use('/public', express.static(__dirname + '/public'));
baseRouter.use('/vnc', express.static("/usr/share/kasmvnc/www/"));
baseRouter.get('/', function (req, res) {
  res.render(__dirname + '/public/index.html', {title: TITLE, path: PATH});
});
baseRouter.get('/favicon.ico', function (req, res) {
  res.sendFile(__dirname + '/public/favicon.ico');
});
baseRouter.get('/manifest.json', function (req, res) {
  res.render(__dirname + '/public/manifest.json', {title: TITLE});
});

//// Web File Browser ////
// Send landing page 
baseRouter.get('/files', function (req, res) {
  res.sendFile( __dirname + '/public/filebrowser.html');
});
// Websocket comms //
io = socketIO(http, {path: SUBFOLDER + 'files/socket.io',maxHttpBufferSize: 200000000});
io.on('connection', async function (socket) {
  let id = socket.id;

  //// Functions ////

  // Open default location
  async function checkAuth(password) {
    getFiles(FM_HOME);
  }

  // Emit to user
  function send(command, data) {
    io.sockets.to(id).emit(command, data);
  }

  // Get file list for directory
  async function getFiles(directory) {
    try { 
      let items = await fsw.readdir(directory);
      if (items.length > 0) {
        let dirs = [];
        let files = [];
        for await (let item of items) {
          let fullPath = directory + '/' + item;
          if (fs.lstatSync(fullPath).isDirectory()) {
            dirs.push(item);
          } else {
            files.push(item);
          }
        }
        send('renderfiles', [dirs, files, directory]);
      } else {
        send('renderfiles', [[], [], directory]);
      }
    } catch (error) {
      send('renderfiles', [[], [], directory]);
    }
  }

  // Send file to client
  async function downloadFile(file) {
    let fileName = file.split('/').slice(-1)[0];
    let data = await fsw.readFile(file);
    send('sendfile', [data, fileName]);
  }

  // Write client sent file
  async function uploadFile(res) {
    let directory = res[0];
    let filePath = res[1];
    let data = res[2];
    let render = res[3];
    let dirArr = filePath.split('/');
    let folder = filePath.replace(dirArr[dirArr.length - 1], '')
    await fsw.mkdir(folder, { recursive: true });
    await fsw.writeFile(filePath, Buffer.from(data));
    if (render) {
      getFiles(directory);
    }
  }

  // Delete files
  async function deleteFiles(res) {
    let item = res[0];
    let directory = res[1];
    item = item.replace("|","'");
    if (fs.lstatSync(item).isDirectory()) {
      await fsw.rm(item, {recursive: true});
    } else {
      await fsw.unlink(item);
    }
    getFiles(directory);
  }

  // Create a folder
  async function createFolder(res) {
    let dir = res[0];
    let directory = res[1];
    if (!fs.existsSync(dir)){
      await fsw.mkdir(dir);
    }
    getFiles(directory);
  }

  // Incoming socket requests
  socket.on('open', checkAuth);
  socket.on('getfiles', getFiles);
  socket.on('downloadfile', downloadFile);
  socket.on('uploadfile', uploadFile);
  socket.on('deletefiles', deleteFiles);
  socket.on('createfolder', createFolder);
});

//// PCM Audio Wrapper ////
aio = socketIO(http, {path: SUBFOLDER + 'audio/socket.io'});
aio.on('connection', function (socket) {
  var record;
  let id = socket.id;

  function open() {
    if (audioEnabled) {
      if (record) record.end();
      record = pulse.createRecordStream({
                 device: 'auto_null.monitor',
                 channels: 2,
                 rate: 44100,
                 format: 'S16LE',
               });
      record.on('error', function(err) {
        console.log('[kclient] audio record stream error (auto_null.monitor not ready?):', err.message || err);
        record = null;
      });
      record.on('connection', function(){
        record.on('data', function(chunk) {
          // Only send non-zero audio data
          let i16Array = Int16Array.from(chunk);
          if (! i16Array.every(item => item === 0)) {
            aio.sockets.to(id).emit('audio', chunk);
          }
        });
      });
    }
  }
  function close() {
    if (audioEnabled) {
      if (record) record.end();
    }
  }

  // Dump blobs to pulseaudio sink
  async function micData(buffer) {
    await fsw.writeFile('/defaults/mic.sock', buffer);
  }

  // Incoming socket requests
  socket.on('open', open);
  socket.on('close', close);
  socket.on('disconnect', close);
  socket.on('micdata', micData);
});

// Spin up application
app.use(SUBFOLDER, baseRouter);
http.listen(LISTEN_PORT);
