// import mcproxy, replace ".."
// with "@rob9315/mcproxy" in your project
import * as mcproxy from '../src';
const minecraft_protocol = require('minecraft-protocol');

// initialize bot instance like you would with mineflayer
// https://github.com/PrismarineJS/mineflayer
let conn = new mcproxy.Conn({
  username: 'Generel_Schwerz',
  // auth: 'microsoft',
  version: '1.12.2',
  host: 'Generel2.aternos.me',
  port:28803,
  skipValidation: true,
});

// do stuff with your bot
conn.stateData.bot.on('spawn', async () => {
  console.log('spawn');
});
conn.stateData.bot.on('error', (err: any) => {
  console.error(err);
});
conn.stateData.bot.on('end', (reason: any) => {
  console.error(reason);
  process.exit(1);
});

// open a server
// https://github.com/PrismarineJS/node-minecraft-protocol
const server = minecraft_protocol.createServer({
  version: '1.12.2',
  host: 'localhost',
  'online-mode': false,
  port: 25566,
});

server.on('listening', () => {
  console.info('Listening on', 25566);
});

// conn.stateData.bot._client.on('login', console.log)
// conn.stateData.bot._client.on('map_chunk', (packet) => {if (packet.blockEntities.length) console.log(JSON.stringify(packet.blockEntities))})

// accept client connections on your server,
// make sure not to use "connection" instead of "login"
server.on('login', async (client: any) => {
  // send packets recreating the current game state to the client
  conn.sendPackets(client);

  // call .link on the incoming client to make the
  // it the one to receive and send all packets
  conn.link(client);
});



