# SocialMeshHall
This is an early prototype for a planned distributed social media network

## Building the Mesh Network
The PeerManager builds and manages a mesh network of WebRTC data channels. There's a simple server that helps get the network started, but a peer can also be connected through another peer so the server isn't building the full network. The server and client can use separate algorithms to build the network, that will be abstracted out eventuall and experimented with.

## Sharing Photos, Videos, and Comments on the Mesh Netwowrk
This is a file sharing layer of the network. Social Media is just file sharing for your pictures and videos, and comments are just text files.

## The Broadcast Layer
There will be a broadcast layer built on top of the file sharing layer, but the file sharing layer needs to be completed first.
