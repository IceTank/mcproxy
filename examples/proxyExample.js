// import mcproxy, replace ".."
// with "@rob9315/mcproxy" in your project
const mcproxy = require('..');
const minecraft_protocol = require('minecraft-protocol');

const VERSION = '1.19.4';
const REMOTE_HOST = 'localhost';
const REMOTE_PORT = 25565;
const LOCAL_PORT = 25566;

// initialize bot instance like you would with mineflayer
// https://github.com/PrismarineJS/mineflayer
let conn = new mcproxy.Conn({
  username: 'proxyBot',
  version: VERSION,
  host: REMOTE_HOST,
  port: REMOTE_PORT,
  skipValidation: true,
});

// do stuff with your bot
conn.stateData.bot.on('spawn', async () => {
  console.log('spawn');
});
conn.stateData.bot.on('error', (err) => {
  console.error(err);
});
conn.stateData.bot.on('end', (reason) => {
  console.error(reason);
  process.exit(1);
});

// open a server
// https://github.com/PrismarineJS/node-minecraft-protocol
const server = minecraft_protocol.createServer({
  version: VERSION,
  host: 'localhost',
  'online-mode': false,
  port: LOCAL_PORT,
});

server.on('listening', () => {
  console.info('Listening on', LOCAL_PORT);
});

// accept client connections on your server,
// make sure not to use "connection" instead of "login"
server.on('login', async (client) => {
  // send packets recreating the current game state to the client
  conn.sendPackets(client);

  // call .link on the incoming client to make the
  // it the one to receive and send all packets
  conn.link(client);
});
