let config = {
    defaultChannel: 'default',
    livePeerConnectionOptions: {},
    mainChannel: 'operator',
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
};
