'use strict';

const Peer = require('./peer');

module.exports = class PeerManager {
    constructor() {
        this.mappedPeers = new Map();
        this.peers = [];
        this.messageHandlers = new Map();
        this.messageHandlers.set('new', this.handleNew.bind(this));
        this.messageHandlers.set('response', this.handleResponse.bind(this));
        this.messageHandlers.set('reject', this.handleRejection.bind(this));
    }

    addPeer(peer_id) {
        let peer = new Peer(peer_id, this);
        // Make sure a peer never tries to friend itself.
        peer.intros.add(peer.peer_id);
        this.mappedPeers.set(peer_id, peer);
        return Promise.resolve(peer);
    }

    removePeer(peer_id) {
        this.mappedPeers.delete(peer_id);
        let index = this.peers.findIndex(element => element.peer_id === peer_id);
        if (index >= 0) {
            this.peers.splice(index, 1);
        }
    }

    handleMessage(peer, msg) {
        if (this.messageHandlers.has(msg.request)) {
            this.messageHandlers.get(msg.request)(peer, msg);
        }
    }

    matchNewPeer(peer, sdp) {
        let index = peer.id - 1;
        let friend = this.peers[index];
        while (friend && peer.intros.has(friend.peer_id)) {
            if (index === 0) {
                index = -1;
                break;
            }
            // Treat peers like a binary search tree.
            index = parseInt(index/2);
            friend = this.peers[index];
        }
        if (!friend || peer.intros.has(friend.peer_id) || index < 0) {
            peer.dc.sendMessage(JSON.stringify({
                request: 'reject',
                sdp: sdp
            }));
        }
        else {
            peer.intros.add(friend.peer_id);
            friend.dc.sendMessage(JSON.stringify({
                request: 'offer',
                from: peer.peer_id,
                sdp: sdp
            }));
        }
    }

    handleNew(peer, msg) {
        this.matchNewPeer(peer, msg.sdp);
    }

    handleResponse(peer, msg) {
        let to = this.mappedPeers.get(msg.to);
        if (to) {
            to.dc.sendMessage(JSON.stringify({
                request: 'answer',
                from: peer.peer_id,
                sdp: msg.sdp
            }));
        }
    }

    handleRejection(peer, msg) {
        let to = this.mappedPeers.get(msg.to);
        if (to) {
            this.matchNewPeer(to, msg.sdp);
        }
    }
};

