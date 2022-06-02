import { Bot, BotOptions, createBot } from 'mineflayer';
import type { Client as mcpClient, PacketMeta } from 'minecraft-protocol';
const { generators } = require("minecraft-packets")
const bufferEqual = require('buffer-equal');

export type Packet = [name: string, data: any];

export type ClientEventTuple = [event: string, listener: (...args: any) => void];
export type ClientEvents = (ClientEventTuple | ((conn: Conn, pclient: Client) => ClientEventTuple))[];

export type Client = mcpClient & {
  toClientMiddlewares: PacketMiddleware[];
  toServerMiddlewares: PacketMiddleware[];
};

export class ConnOptions {
  optimizePacketWrite: boolean = true;
  //* Middleware to control packets being send to the client and server
  toClientMiddleware?: PacketMiddleware[] = [() => {}];
  //* Middleware to control packets being send to the client and server
  toServerMiddleware?: PacketMiddleware[] = [() => {}];
}

export interface packetCanceler {
  /** Has property .isCanceled: boolean indicating if the packet has been canceled by another middleware.
   * Use `cancel(false)` to un-cancel the packet again.
   */
  (unCancel?: boolean): void
  isCanceled: boolean
} 

export interface packetUpdater {
  (update?: boolean): void;
  isUpdated: boolean;
}

export interface PacketMiddleware {
  (info: {
    bound: 'server' | 'client',
    writeType: 'packet' | 'rawPacket' | 'channel',
    meta: PacketMeta
  }, pclient: Client, data: any, cancel: packetCanceler): void | Promise<void>;
}

export class Conn {
  packetGenerator: any
  options: ConnOptions;
  bot: Bot & { recipes: number[] };
  /** Internal whitelist for the bot */
  private internalWhitelist: string[] = ['keep_alive'];
  optimizePacketWrite: boolean = true;
  /** Contains the currently writing client or undefined if there is none */
  writingPclient: Client | undefined;
  /** Contains clients that are actively receiving packets from the proxy bot */
  receivingPclients: Client[] = [];
  /** Contains all connected clients. Even when they are not receiving or sending any packets */
  pclients: Client[] = [];
  toClientDefaultMiddleware?: PacketMiddleware[] = undefined;
  toServerDefaultMiddleware?: PacketMiddleware[] = undefined;
  write: (name: string, data: any) => void = () => {};
  writeRaw: (buffer: any) => void = () => {};
  writeChannel: (channel: any, params: any) => void = () => {};
  constructor(botOptions: BotOptions, options?: Partial<ConnOptions>) {
    this.options = { ...new ConnOptions(), ...options };
    this.bot = createBot(botOptions) as any;
    this.bot.recipes = [];
    this.receivingPclients = [];
    this.pclients = [];
    this.write = this.bot._client.write.bind(this.bot._client);
    this.writeRaw = this.bot._client.writeRaw.bind(this.bot._client);
    this.writeChannel = this.bot._client.writeChannel.bind(this.bot._client);
    const mcData = require('minecraft-data')(this.bot.version)
    const { VersionGenerator } = generators[mcData.version.majorVersion]
    this.packetGenerator = new VersionGenerator(this.bot)
    this.optimizePacketWrite = this.options.optimizePacketWrite;
    if (options?.toClientMiddleware) this.toClientDefaultMiddleware = options.toClientMiddleware;
    if (options?.toServerMiddleware) this.toServerDefaultMiddleware = options.toServerMiddleware;

    this.internalWhitelist = ['keep_alive'];

    this.bot._client.on('raw', this.onServerRaw.bind(this));
  }

  /**
   * Called when the proxy bot receives a packet from the server. Forwards the packet to all attached and receiving clients taking
   * attached middleware's into account.
   * @param buffer Buffer
   * @param meta
   * @returns
   */
  async onServerRaw(buffer: Buffer, meta: PacketMeta) {
    // @ts-ignore-error
    const packetData = this.bot._client.deserializer.parsePacketBuffer(buffer).data.params;
    for (const pclient of this.receivingPclients) {
      if (pclient.state !== states.PLAY || meta.state !== states.PLAY) {
        return;
      }
      // Build packet canceler function used by middleware
      const cancel: packetCanceler = Object.assign(
        (unCancel: boolean = false) => {
          cancel.isCanceled = unCancel ? false : true;
          update.isUpdated = true;
        },
        { isCanceled: false }
      );
      const update: packetUpdater = Object.assign(
        (unUpdate: boolean = false) => {
          update.isUpdated = !!unUpdate;
        },
        { isUpdated: false }
      );

      for (const middleware of pclient.toClientMiddlewares) {
        const funcReturn = middleware({ bound: 'client', meta, writeType: 'packet' }, pclient, packetData, cancel, update);
        if (funcReturn instanceof Promise) {
          await funcReturn;
        }
      }
      // TODO: figure out what packet is breaking crafting on 2b2t
      // Hint: It is the recipes unlock packet that is send when crafting an item.
      // Probably some bad unlocked recipes packet reconstruction on login that is causing packets send after to crash the client.

      if (cancel.isCanceled === false) {
        if (!update.isUpdated && !this.optimizePacketWrite) {
          pclient.writeRaw(buffer);
          return;
        }
        if (this.optimizePacketWrite) {
          // @ts-ignore-error
          const packetBuff = pclient.serializer.createPacketBuffer({ name: meta.name, params: packetData });
          if (!bufferEqual(buffer, packetBuff)) {
            console.log('client<-server: Error in packet ' + meta.state + '.' + meta.name + ' This packet is breaking the proxy. Ping @Ic3Tank on NextGen discord');
            pclient.writeRaw(buffer);
            return;
          }
        }
        pclient.write(meta.name, packetData);
      }
    }
  }

  /**
   * Handles packets send by a client to a server taking attached middleware's into account.
   * @param data Packet data
   * @param meta Packet Meta
   * @param pclient Sending Client
   */
  onClientPacket(data: any, meta: PacketMeta, buffer: Buffer, pclient: Client) {
    const handle = async () => {
      // Build packet canceler function used by middleware
      const cancel: packetCanceler = Object.assign(
        (unCancel: boolean = false) => {
          cancel.isCanceled = unCancel ? false : true;
          update.isUpdated = true;
        },
        { isCanceled: false }
      );
      const update: packetUpdater = Object.assign(
        (unUpdate: boolean = false) => {
          update.isUpdated = !!unUpdate;
        },
        { isUpdated: false }
      );

      for (const middleware of pclient.toServerMiddlewares) {
        const funcReturn = middleware({ bound: 'server', meta, writeType: 'packet' }, pclient, data, cancel, update);
        if (funcReturn instanceof Promise) {
          await funcReturn;
        }
      }
      if (cancel.isCanceled === false) {
        if (!update.isUpdated && this.optimizePacketWrite) {
          pclient.writeRaw(buffer);
          return;
        }
        // TODO: figure out what packet is breaking crafting on 2b2t
        if (this.optimizePacketWrite) {
          // @ts-ignore-error
          const packetBuff = pclient.serializer.createPacketBuffer(data);
          if (!bufferEqual(buffer, packetBuff)) {
            console.log('server<-client: Error in packet ' + meta.state + '.' + meta.name + ' This packet is breaking the proxy. Ping @Ic3Tank on NextGen discord');
            this.writeRaw(buffer);
            return;
          }
        }
        this.write(meta.name, data);
      }
    };
    handle().catch(console.error);
  }

  /**
   * Register middleware to be used as client to server middleware.
   * @param pclient Client
   */
  _serverClientDefaultMiddleware(pclient: Client) {
    if (!pclient.toClientMiddlewares) pclient.toClientMiddlewares = []
    pclient.toClientMiddlewares.push((info: {
      bound: 'server' | 'client',
      writeType: 'packet' | 'rawPacket' | 'channel',
      meta: PacketMeta
    }, pclient: Client, data: any, cancel: packetCanceler) => {
      if (!this.receivingPclients.includes(pclient)) return cancel()
    })
    // (conn, pclient) => ['end', () => conn.detach(pclient)],
    // (conn, pclient) => ['error', () => conn.detach(pclient)],
  }

  /**
   * Register the default (first) middleware used to control what client can interact with the current bot.
   * @param pclient Client
   */
  _clientServerDefaultMiddleware(pclient: Client) {
    if (!pclient.toServerMiddlewares) pclient.toServerMiddlewares = []
    function defaultClientServerMiddleware(this: any, info: {
      bound: 'server' | 'client',
      writeType: 'packet' | 'rawPacket' | 'channel',
      meta: PacketMeta
    }, pclient: Client, data: any, cancel: packetCanceler) {
      const name = info.meta.name
      //* check if client is authorized to modify connection (sending packets and state information from mineflayer)
      if (info.meta.name === 'teleport_confirm' && data?.teleportId === 0) {
        pclient.write('position', {
          ...this.bot.entity.position,
          yaw: 180 - (this.bot.entity.yaw * 180) / Math.PI,
          pitch: -(this.bot.entity.pitch * 180) / Math.PI,
          teleportId: 1
        })
        cancel()
      }
      if (this.writingPclient !== pclient) {
        // console.info(info.meta.name, 'Client -> Server Canceled')
        return cancel()
      }
      if (info.meta.name === 'keep_alive') cancel()
      // console.info(info.meta.name, 'Client -> Server not Canceled', this.writingPclient, pclient)
      //* keep mineflayer info up to date
      switch (name) {
        case 'position':
          this.bot.entity.position.x = data.x;
          this.bot.entity.position.y = data.y;
          this.bot.entity.position.z = data.z;
          this.bot.entity.onGround = data.onGround;
          break;
        case 'position_look': // FALLTHROUGH
          this.bot.entity.position.x = data.x;
          this.bot.entity.position.y = data.y;
          this.bot.entity.position.z = data.z;
        case 'look':
          this.bot.entity.yaw = ((180 - data.yaw) * Math.PI) / 180;
          this.bot.entity.pitch = -(data.pitch * Math.PI) / 180;
          this.bot.entity.onGround = data.onGround;
          break;
        case 'held_item_slot':
          this.bot.quickBarSlot = data.slotId;
          break;
        case 'abilities':
          this.bot.physicsEnabled = !!((data.flags & 0b10) ^ 0b10);
          break;
      }
    }
    pclient.toServerMiddlewares.push(defaultClientServerMiddleware.bind(this))
  }

  /**
   * Register new pclient (connection coming from mc-protocol server) to the list of pclient.
   * @param pclient 
   * @param options 
   */
  registerNewPClient(pclient: Client, options?: { toClientMiddleware?: PacketMiddleware, toServerMiddleware?: PacketMiddleware }) {
    this._clientServerDefaultMiddleware(pclient)
    this._serverClientDefaultMiddleware(pclient)
    this.pclients.push(pclient);
    pclient.on('end', () => {
      this.unregisterPClient(pclient)
    })
    pclient.on('packet', (data, meta, buffer) => this.onClientPacket(data, meta, buffer, pclient))
    if (options?.toClientMiddleware) pclient.toClientMiddlewares.push(options.toClientMiddleware)
    if (options?.toServerMiddleware) {
      console.info('Added additional toServer middleware')
      pclient.toServerMiddlewares.push(options.toServerMiddleware)
      console.info(pclient.toServerMiddlewares)
    } else {
      console.info('no additional to server middleware')
    }
  }

  /**
   * Un-register a client. 
   * Assume .end() was called on pclient. Don't send any more packets and don't listen for any new packets received.
   * @param pclient Client
   */
  unregisterPClient(pclient: Client) {
    this.pclients = this.pclients.filter(c => c !== pclient)
    this.receivingPclients = this.receivingPclients.filter(c => c !== pclient)
    pclient.removeAllListeners('packet')
    if (this.writingPclient === pclient) this.unlink()
  }

  /**
   * Send all packets to a client that are required to login to a server.
   * @param pclient
   */
  sendPackets(pclient: Client) {
    console.info('sendPackets for', this.bot.majorVersion)
    const packets = this.packetGenerator.packetsLoginSequence() as { name: string, data: any }[]
    packets.forEach(p => {
      pclient.write(p.name, p.data)
    })
  }

  //* attaching means receiving all packets from the server
  attach(pclient: Client, options?: { toClientMiddleware?: PacketMiddleware, toServerMiddleware?: PacketMiddleware }) {
    console.info('Attach')
    if (!this.pclients.includes(pclient)) {
      this.registerNewPClient(pclient, options)
      // if (options && options.toClientMiddleware) pclient.toClientMiddleware = options.toClientMiddleware;
      // this.pclients.push(pclient);
      // this.options.events.map(customizeClientEvents(this, pclient)).forEach(([event, listener]) => pclient.on(event, listener));
    }
    if (!this.receivingPclients.includes(pclient)) {
      this.receivingPclients.push(pclient)
    }
  }
  //* reverses attaching
  //* a client that isn't attached anymore will no longer receive packets from the server
  //* if the client was the main client, it will also be unlinked.
  detach(pclient: Client) {
    this.receivingPclients = this.pclients.filter((client) => client !== pclient);
    // this.options.events.map(customizeClientEvents(this, pclient)).forEach(([event, listener]) => pclient.removeListener(event, listener));
    if (this.writingPclient === pclient) this.unlink();
  }

  //* linking means being the main client on the connection, being able to write to the server
  //* if not previously attached, this will do so.
  link(pclient: Client, options?: { toClientMiddleware?: PacketMiddleware }) {
    this.writingPclient = pclient;
    this.bot._client.write = this.writeIf.bind(this);
    this.bot._client.writeRaw = () => {};
    this.bot._client.writeChannel = () => {};
    this.attach(pclient, options);
  }
  //* reverses linking
  //* doesn't remove the client from the pclients array, it is still attached
  unlink() {
    if (this.writingPclient) {
      this.bot._client.write = this.write.bind(this.bot._client);
      this.bot._client.writeRaw = this.writeRaw.bind(this.bot._client);
      this.bot._client.writeChannel = this.writeChannel.bind(this.bot._client);
      this.writingPclient = undefined;
    }
  }

  //* internal filter
  writeIf(name: string, data: any) {
    if (this.internalWhitelist.includes(name)) this.write(name, data);
  }
  //* disconnect from the server and ends, detaches all pclients
  disconnect() {
    this.bot._client.end('conn: disconnect called');
    this.receivingPclients.forEach(this.detach.bind(this));
  }
}

// const defaultEvents: ClientEvents = [
//   (conn, pclient) => [
//     'packet',
//     (data, { name }, buffer) => {
//       //* check if client is authorized to modify connection (sending packets and state information from mineflayer)
//       if (pclient.toServerWhiteList?.includes(name) || (conn.writingPclient === pclient && !(pclient.toServerBlackList ?? conn.options.toServerBlackList).includes(name))) {
//         //* relay packet
//         conn.writeRaw(buffer);
//         //* keep mineflayer info up to date
//         switch (name) {
//           case 'position':
//             conn.bot.entity.position.x = data.x;
//             conn.bot.entity.position.y = data.y;
//             conn.bot.entity.position.z = data.z;
//             conn.bot.entity.onGround = data.onGround;
//             break;
//           case 'position_look': // FALLTHROUGH
//             conn.bot.entity.position.x = data.x;
//             conn.bot.entity.position.y = data.y;
//             conn.bot.entity.position.z = data.z;
//           case 'look':
//             conn.bot.entity.yaw = ((180 - data.yaw) * Math.PI) / 180;
//             conn.bot.entity.pitch = -(data.pitch * Math.PI) / 180;
//             conn.bot.entity.onGround = data.onGround;
//             break;
//           case 'held_item_slot':
//             conn.bot.quickBarSlot = data.slotId;
//             break;
//           case 'abilities':
//             conn.bot.physicsEnabled = !!((data.flags & 0b10) ^ 0b10);
//             break;
//         }
//       }
//     },
//   ],
//   (conn, pclient) => ['end', () => conn.detach(pclient)],
//   (conn, pclient) => ['error', () => conn.detach(pclient)],
// ];
