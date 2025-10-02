'use strict';

const nodeDataChannel = require('node-datachannel');

module.exports = class Peer {
    constructor(peer_id, peerMgr) {
        this.peer_id = peer_id;
        this.intros = new Set();
        let peer = new nodeDataChannel.PeerConnection(peer_id, { iceServers:[] });
        this.peer = peer;
        this.sdp = new Promise( (resolve, reject) => {
            peer.onGatheringStateChange(state => {
                if (state === 'complete') {
                    resolve(peer.localDescription());
                }
            });
        });
        peer.onDataChannel((dc) => {
            if (!this.dc) {
                this.dc = dc;
                this.id = peerMgr.peers.push(this) - 1;
                dc.onMessage(msg => {
                    try {
                        peerMgr.handleMessage(this, JSON.parse(msg.toString()));
                    }
                    catch(err) {
                        console.log(err);
                    }
                });
                dc.onClosed( () => {
                    console.log('dc closed for ' + this.peer_id);
                    delete this.dc;
                    peerMgr.removePeer(peer_id);
                });
            }
        });
    }

    getSDP(sdp) {
        this.peer.setRemoteDescription(sdp, 'offer');
        return this.sdp;
    }
};

