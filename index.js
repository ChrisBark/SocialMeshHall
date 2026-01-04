'use strict';

const express = require('express');
const fs = require('node:fs');
const https = require('node:https');
const { randomInt } = require('node:crypto');
const PeerManager = require('./lib/peermgr');

const options = {
  key: fs.readFileSync('ssl/cert.key').toString(),
  cert: fs.readFileSync('ssl/cert.pem').toString(),
};

const app = express();
let peers = new PeerManager();

app.use(express.static('public'));
app.use(express.json());

app.get('/config.js', (req, res, next) => {
    let name = randomInt(99999999).toString();
    while(peers.mappedPeers.has(name)) {
        name = randomInt(99999999).toString();
    }
    res.type('.js');    
    res.send(`const config = {
        defaultChannel: 'default',
        mainChannel: 'operator',
        name: '${name}',
        options: {
            minConnections: 3,
            capConnections: 10,
            connectionInterval: 300000,
            peerConnectionOptions: {
                iceServers: [
                    //{ urls: "stun:stun.l.google.com:19302" },
                    //{ urls: "stun:stun.l.google.com:5349" },
                    //{ urls: "stun:stun1.l.google.com:3478" },
                    //{ urls: "stun:stun1.l.google.com:5349" },
                    //{ urls: "stun:stun2.l.google.com:19302" },
                    //{ urls: "stun:stun2.l.google.com:5349" },
                    //{ urls: "stun:stun3.l.google.com:3478" },
                    //{ urls: "stun:stun3.l.google.com:5349" },
                    //{ urls: "stun:stun4.l.google.com:19302" },
                    //{ urls: "stun:stun4.l.google.com:5349" }
                ]
            },
            dataChannelOptions: {
                //ordered: false
            }
        }
    };`);
});

app.post('/', (req, res, next) => {
    peers.addPeer(req.body.name)
    .then( peer => {
        return peer.getSDP(req.body.sdp);
    })
    .then( sdp => {
        res.format({
            'application/json': () => {
                res.send(JSON.stringify({sdp}));
            },
            default: () => {
                res.status(406).send('Not Acceptable');
            }
        });
    })
    .catch( err => {
        next(err);
    });
});

const server = https.createServer(options, app);

server.listen(8080, () => {
  console.log(`App listening on port 8080`);
});

