
const config = require('./config.json');

const https = require('https');
const fs = require('graceful-fs');
const express = require('express');
const app = express();
var socket = require('socket.io');

var options = {
    key: fs.readFileSync(config.sslOptions.key),
    cert: fs.readFileSync(config.sslOptions.cert),
    ca: fs.readFileSync(config.sslOptions.ca)
};


var server = https.createServer(options, app).listen(config.port);
console.log('Server started on port', server.address().port)


app.use(express.static('public'));


/**
 * Static methods for Broadcast
 * @class WebRTC
 * @static
 */
function Broadcast() {}
Broadcast.rooms = [];
function eventSystem(){

    var events = {};

    var CustomEvent = function (eventName) {

        this.eventName = eventName;
        this.callbacks = [];

        this.registerCallback = function(callback) {
            this.callbacks.push(callback);
        }

        this.unregisterCallback = function(callback) {
            const index = this.callbacks.indexOf(callback);
            if (index > -1) {
                this.callbacks.splice(index, 1);
            }
        }

        this.fire = function(data) {
            const callbacks = this.callbacks.slice(0);
            callbacks.forEach((callback) => {
                callback(data);
            });
        }
    }

    var dispatch = function(eventName, data) {
        if(!doesHandlerExist(eventName)) {
            return;
        }

        const event = events[eventName];
        if (event) {
            event.fire(data);
        }
    }

    var on = function(eventName, callback) {
        let event = events[eventName];
        if (!event) {
            event = new CustomEvent(eventName);
            events[eventName] = event;
        }
        event.registerCallback(callback);
    }

    var off = function(eventName, callback) {
        const event = events[eventName];
        if (event && event.callbacks.indexOf(callback) > -1) {
            event.unregisterCallback(callback);
            if (event.callbacks.length === 0) {
                delete events[eventName];
            }
        }
    }

    var doesHandlerExist = function (eventName) {
        if(events[eventName] != null && events[eventName].callbacks.length != 0) return true;
        return false;
    }

    return {
        dispatch:dispatch,
        on:on,
        off:off,
    }
}

Broadcast.Room = function (id) {
    this.id = id;
    this.isActive = true;
    this.roomPublisherId = id;
    this.publisherParticipant = null;
    this.participants = [];
    this.maxChildren = 2;
    this.addParticipant = function (participant) {
        let participantExists;
        for (let p in this.participants) {
            if(this.participants[p] == participant) {
                participantExists = true;
                break;
            }
        }
        if(participantExists) return;

        this.participants.push(participant);
        if(participant.role == 'publisher') {
            this.publisherParticipant = participant;
            console.log('PUBLISHER CONNECTED');

        }
        participant.online = true;
        participant.room = this;
    }
    this.getParticipants = function (all) {
        if(all) {
            return this.participants;
        } else {
            return this.participants.filter(function (participant) {
                return (participant.online !== false);
            });
        }
    }
    this.close = function () {
        console.log('close room');
        var room = this;
        this.isActive = false;
        this.removeTimer = setTimeout(function () {
            room.remove();
        }, 1000*30)
    }
    this.remove = function () {
        console.log('close room');

        var room = this;
        for (var i = Broadcast.rooms.length - 1; i >= 0; i--) {
            if (Broadcast.rooms[i] == room) {
                Broadcast.rooms.splice(i, 1);
                break;
            }
        }
        room = null;
    }
    this.active = function (value) {
        if(value === true) {
            if(this.removeTimer != null) {
                clearTimeout(this.removeTimer);
                this.removeTimer = null;
            }
        }
        this.isActive = value;
    }
    this.removeTimer = null;
    this.event = eventSystem();
}
Broadcast.getRoom = function (id) {
    for(let i in Broadcast.rooms) {
        if(Broadcast.rooms[i].id == id){
            return Broadcast.rooms[i];
        };
    }
    return false;
}

Broadcast.Participant = function (id) {
    this.id = id;
    this.online = false;
    this.name = 'Connecting...';
    this.room = null;
    this.donors = [];
    this.receivers = [];
    this.removeFromRoom = function () {
        if(this.room == null) return;
        for (let i = this.room.participants.length - 1; i >= 0; i--) {
            if (this.room.participants[i] == this) {
                this.room.participants.splice(i, 1);
                break;
            }
        }

        for (let i = this.room.participants.length - 1; i >= 0; i--) {
            let participant = this.room.participants[i];
            console.log('removeFromRoom: role', participant.role);

            for (let r = participant.receivers.length - 1; r >= 0; r--) {
                console.log('removeFromRoom: remove from recvrs', participant.receivers[r].id, this.id, participant.receivers[r] == this);

                if (participant.receivers[r] == this) {
                    participant.receivers.splice(r, 1);
                    break;
                }
            }

            for (let d = participant.donors.length - 1; d >= 0; d--) {
                console.log('removeFromRoom: removeDonor .. ', participant.donors[d].id, this.id);

                if (participant.donors[d] == this) {
                    console.log('removeFromRoom: removeDonor');
                    participant.donors.splice(d, 1);
                    break;
                }
            }
        }
    }
}


// socket setup
var io = socket(server);

var nspName = '/broadcast';
var broadcastNamespace = io.of(nspName);

broadcastNamespace.on('connection', function(socket) {
    console.log('broadcast: made sockets connection', socket.id);
    var roomId;
    var broadcastRoom;
    var localParticipant;

    socket.on('Streams/broadcast/joined', function (identity) {
        console.log('Got message: joined ', identity, socket.id);
        socket.role = identity.role;
        socket.info = identity.info;
        socket.roomId = roomId = identity.room;
        socket.roomStartTime = identity.roomStartTime;

        if(socket.broadcastParticipant == null) {
            var currentParticipant = localParticipant = new Broadcast.Participant(socket.id)
            currentParticipant.id = socket.id;
            currentParticipant.role = identity.role;
            currentParticipant.connectedTime = new Date().getTime();
            currentParticipant.info = identity.info;
            socket.broadcastParticipant = currentParticipant;
        }

        var existingRoom = Broadcast.getRoom(roomId);
        if(!existingRoom) {
            var currentRoom = broadcastRoom = new Broadcast.Room(identity.room);
            currentRoom.roomPublisherId = identity.roomPublisher;
            Broadcast.rooms.push(currentRoom);
            socket.broadcastRoom = currentRoom;
        } else {
            broadcastRoom = existingRoom;
        }

        broadcastRoom.addParticipant(currentParticipant);

        for (var key in socket.adapter.rooms) {
            if (socket.adapter.rooms.hasOwnProperty(key)) {
                if(key == identity.room) {
                    console.log('rooms: roomExists');
                    break;
                }
            }
        }

        //console.log(socket.join.toString());
        socket.join(roomId)/*.then(function () {
            console.log(socket.id + ' now in rooms: ', socket.rooms);
            io.of(nspName).in(roomId).clients(function (error, clients) {
                console.log('PARTICIPANTS IN THE ROOM', clients.length);
            });
        })*/

        console.log(socket.rooms)

        console.log('Participant joined to room', roomId);
        console.log('Participant joined', currentParticipant);


        if(localParticipant.role == 'publisher') {
            console.log('PUBLISHER CONNECTING ...', localParticipant.id);

            findReceiver(localParticipant);

        } else if(localParticipant.role == 'receiver') {
            findDonor(localParticipant);
        }

    });

    function findReceiver(donorParticipant) {
        console.log('PUBLISHER CONNECTING: findReceiver ', donorParticipant.id);
        for(let p in broadcastRoom.participants) {
            console.log('PUBLISHER CONNECTING: findReceiver ... donors ', broadcastRoom.participants[p].role, broadcastRoom.participants[p].donors.length);

            if(broadcastRoom.participants[p].role == 'receiver' && broadcastRoom.participants[p].donors.length == 0) {
                console.log('PUBLISHER CONNECTING: receiver found ', broadcastRoom.participants[p].id);
                donorParticipant.receivers.push(broadcastRoom.participants[p]);
                broadcastRoom.participants[p].donors.push(donorParticipant);

                broadcastNamespace.to(donorParticipant.id).emit('Streams/broadcast/participantConnected', {
                    sid:broadcastRoom.participants[p].id,
                    info:broadcastRoom.participants[p].info,
                    fromSid:broadcastRoom.participants[p].id
                });

                findReceiver(broadcastRoom.participants[p]);

                if(donorParticipant.receivers == broadcastRoom.maxChildren) {
                    break;
                }
            }
        }
    }
    function findDonor(receiverParticipant) {
        console.log('findDonor', receiverParticipant.id);
        for(let p in broadcastRoom.participants) {
            var roomParticipant = broadcastRoom.participants[p];
            if(roomParticipant == receiverParticipant || amIParentOf(roomParticipant, receiverParticipant)) continue;
            console.log('findDonor: searching ...', roomParticipant.receivers.length, broadcastRoom.maxChildren, roomParticipant.role, roomParticipant.receivers[0] ? roomParticipant.receivers[0].id : null);

            if(((roomParticipant.role == 'receiver' && roomParticipant.donors.length != 0) || roomParticipant.role == 'publisher')
                && roomParticipant.receivers.length < broadcastRoom.maxChildren) {
                console.log('findDonor: donor found', roomParticipant.id);

                askPermissionToConnect(roomParticipant).then(answer => {
                    console.log('askPermissionToConnect answer', answer);
                    if(answer === true) {
                        broadcastNamespace.to(roomParticipant.id).emit('Streams/broadcast/participantConnected', {
                            username: receiverParticipant.username,
                            sid: receiverParticipant.id,
                            info: receiverParticipant.info,
                            fromSid: receiverParticipant.id
                        });
                        roomParticipant.receivers.push(receiverParticipant);
                        receiverParticipant.donors.push(roomParticipant);
                    }
                })

                break;
            }
        }
    }

    async function askPermissionToConnect(roomParticipant) {
        console.log('askPermissionToConnect', roomParticipant.id)

        return await new Promise(resolve => {
            function onPermissionReqResult(result) {
                console.log('askPermissionToConnect result result.fromSid', result.fromSid, roomParticipant.id)

                if(result.fromSid == (roomParticipant.id)) {
                    //let resp = JSON.parse(result)
                    console.log('askPermissionToConnect result', result.answer)
                    broadcastRoom.event.off('permissionReqResult', onPermissionReqResult)
                    resolve(result.answer);
                }
            }
            broadcastRoom.event.on('permissionReqResult', onPermissionReqResult)
            console.log('askPermissionToConnect emit', roomParticipant.id)

            broadcastNamespace.to(roomParticipant.id).emit('Streams/broadcast/canIConnect', {'bla':'bla'});
        });
    }

    // check if participant to whom we are searching donor is parent of  potentional donor
    function amIParentOf(potentionalChild, potentionalParent) {
        var parent = false;
        function isParent(participant) {
            for(let d in participant.donors) {
                if(participant.donors[d].id == potentionalParent.id){
                    parent = true;
                } else {
                    isParent(participant.donors[d])
                }
            }
        }

        isParent(potentionalChild)

        console.log('amIParentOf', potentionalChild.id, potentionalParent.id, parent)
        return parent
    }

    socket.on('permissionReqResult', function(message) {
        broadcastRoom.event.dispatch('permissionReqResult', message)
    });

    socket.on('Streams/broadcast/confirmOnlineStatus', function(message) {
        console.log('confirmOnlineStatus', message);
        message.fromSid = socket.id;
        socket.to(message.targetSid).emit('Streams/broadcast/confirmOnlineStatus', message);

    });

    socket.on('Streams/broadcast/canISendOffer', function(message) {
        console.log('canISendOffer', message);
        message.fromSid = socket.id;
        socket.to(message.targetSid).emit('Streams/broadcast/canISendOffer', message);

    });

    socket.on('Streams/broadcast/signalling', function(message) {
        console.log('SIGNALLING MESSAGE', message.type, message.targetSid, socket.id);
        console.log('SIGNALLING message.targetSid', message.targetSid);
        message.fromSid = socket.id;
        if(message.type == 'offer') message.info = socket.info;

        socket.to(message.targetSid).emit('Streams/broadcast/signalling', message);
    });


    socket.on('disconnect', function() {
        if(!roomId) return;
        console.log('DISCONNECT', socket.id, socket.userPlatformId, 'Streams/webrtc/' + roomId);
        /*io.of(nspName).in(roomId).clients(function (error, clients) {
            console.log('PARTICIPANTS IN THE ROOM', clients.length);
            if(clients.length > 0) {
                return;
            }
        });*/

        localParticipant.removeFromRoom();
        if(localParticipant.role != 'publisher') {
            for (let r in localParticipant.receivers) {
                findDonor(localParticipant.receivers[r])
            }
        }

        socket.broadcast.to(roomId).emit('Streams/broadcast/participantDisconnected', socket.id);
    });

})
