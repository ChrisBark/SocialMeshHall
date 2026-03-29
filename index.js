'use strict';

const cookieParser = require('cookie-parser');
const express = require('express');
const fs = require('node:fs');
const https = require('node:https');
const { OAuth2Client } = require('google-auth-library');
const path = require('path');
const { randomInt } = require('node:crypto');
const PeerManager = require('./lib/peermgr');

var options;
if (process.argv[2]) {
    options = JSON.parse(fs.readFileSync(process.argv[2]));
}
else {
    options = {};
}
options.key = fs.readFileSync(options.keyFile??'/usr/local/etc/ssl/cert.key').toString();
options.cert = fs.readFileSync(options.certFile??'/usr/local/etc/ssl/cert.pem').toString();

const app = express();
let peers = new PeerManager();
const client = new OAuth2Client();
let clientMap = new Map();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true}));
app.use(cookieParser());

app.get('/', (req, res, next) => {
    res.render('login', {
        googleScript: options.login?.google?.script,
        googleClientId: options.login?.google?.clientId,
        googleLoginURI: options.login?.google?.loginURI
    });
});

app.post('/login', (req, res, next) => {
    if (options.login?.google && req.cookies?.g_csrf_token === req.body?.g_csrf_token) {
        client.verifyIdToken({
            idToken: req.body.credential,
            audience: options.login.google.audience
        })
        .then( login => {
            let id = Math.floor(Math.random() * 4294967296);
            while (clientMap.has(id)) {
                id = Math.floor(Math.random() * 4294967296);
            }
            clientMap.set(id.toString(), {email: login.payload.email});
            res.render('client', {email: login.payload.email, id});
        })
        .catch( err => {
            res.status(404).end();
        });
    }
    else {
        res.status(404).end();
    }
});

app.post('/', (req, res, next) => {
    const client = clientMap.get(req.body?.id);
    if (!client) {
        res.status(404).end();
        return;
    }
    peers.addPeer(req.body.name)
    .then( peer => {
        // MAke sure they used a unique name before deleting the entry from
        // the client map.
        clientMap.delete(req.body.id);
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
        if (err === 'EADDRINUSE') {
            return res.status(409).send('Conflict');
        }
        res.status(404).end();
    });
});

const server = https.createServer(options, app);

server.listen(8080, () => {
  console.log(`App listening on port 8080`);
});

