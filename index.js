'use strict';

const cookieParser = require('cookie-parser');
const express = require('express');
const fs = require('node:fs');
const https = require('node:https');
const { OAuth2Client } = require('google-auth-library');
const path = require('path');
const { randomInt } = require('node:crypto');
const PeerManager = require('./lib/peermgr');

const options = {
  key: fs.readFileSync('ssl/cert.key').toString(),
  cert: fs.readFileSync('ssl/cert.pem').toString(),
};

const app = express();
let tableMap = new Map();
const client = new OAuth2Client();
let clientMap = new Map();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true}));
app.use(cookieParser());

app.get('/table/:table', (req, res, next) => {
    if (!tableMap.has(req.params.table)) {
        tableMap.set(req.params.table, new PeerManager());
    }
    res.render('login', {table: req.params.table});
});

app.post('/table/:table', (req, res, next) => {
    if (req.cookies?.g_csrf_token === req.body?.g_csrf_token) {
        client.verifyIdToken({
            idToken: req.body.credential,
            audience: '118095101781-8qj8o9u54p6f2poppmplfe51nnbcan1v.apps.googleusercontent.com'
        })
        .then( login => {
            let id = Math.floor(Math.random() * 64000);
            while (clientMap.has(id)) {
                id = Math.floor(Math.random() * 64000);
            }
            clientMap.set(id.toString(), {email: login.payload.email, table: req.params.table});
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

app.get('/', (req, res, next) => {
    res.redirect('/table/default');
});

app.post('/', (req, res, next) => {
    const client = clientMap.get(req.body?.id);
    if (!client) {
        res.status(404).end();
        return;
    }
    const peerManager = tableMap.get(client.table);
    if (!peerManager) {
        res.status(404).end();
        return;
    }
    clientMap.delete(req.body.id);
    peerManager.addPeer(req.body.name)
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

