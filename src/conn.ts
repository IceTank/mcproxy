import { Bot, BotOptions, createBot } from "mineflayer";
import { Client as mcpClient, PacketMeta } from "minecraft-protocol";
import { createClient } from "minecraft-protocol";
import { states } from "minecraft-protocol";
import { generatePackets } from "./packets";
import { StateData } from "./stateData";
import { IPositionTransformer, SimplePositionTransformer } from "./positionTransformer";
import { Vec3 } from "vec3";
import { Version } from "minecraft-data";

export type Packet = [name: string, data: any];

export type ClientEventTuple = [event: string, listener: (...args: any) => void];
export type ClientEvents = (ClientEventTuple | ((conn: Conn, pclient: Client) => ClientEventTuple))[];

export type Client = mcpClient & {
  toClientMiddlewares: PacketMiddleware[];
  toServerMiddlewares: PacketMiddleware[];

  lastDelimiter: number;

  on(event: "mcproxy:detach", listener: () => void): void;
  on(event: "mcproxy:heldItemSlotUpdate", listener: () => void): void;
};

export class ConnOptions {
  optimizePacketWrite: boolean = true;
  //* Middleware to control packets being sent from the server to the client
  toClientMiddleware?: PacketMiddleware[] = [];
  //* Middleware to control packets being sent from the client to the server
  toServerMiddleware?: PacketMiddleware[] = [];
  positionTransformer?: IPositionTransformer | Vec3;
}

export interface packetUpdater {
  (update?: boolean): void;
  isUpdated: boolean;
}

interface PacketData {
  /** Direction the packet is going. Should always be the same direction depending on what middleware direction you
   * are registering.
   */
  bound: "server" | "client";
  /** Only 'packet' is implemented */
  writeType: "packet" | "rawPacket" | "channel";
  /** Packet meta. Contains the packet name under `name` also see {@link PacketMeta} */
  meta: PacketMeta;
  /** The client connected to this packet */
  pclient: Client | null;
  /** Parsed packet data as returned by nmp */
  data: any;
  /** Indicator if the packet is canceled or not */
  isCanceled: boolean;
}

export interface PacketMiddleware {
  (packetData: PacketData): PacketMiddlewareReturnValue | Promise<PacketMiddlewareReturnValue>;
}

type PacketMiddlewareReturnValue = object | undefined | false | true | void;


export type MiddlewareHandlerOpts = {
  client?: PacketMiddleware[];
  server?: PacketMiddleware[];
  onRecieve?: PacketMiddleware[];
  onSend?: PacketMiddleware[];
}


export class NewStateData {
  flying: boolean = false;
  public readonly client: mcpClient;
  rawLoginPacket: any;
  rawCommandPacket: any;
  rawTags: any = [];
  rawRecipes: any[] | null = null;
  rawUnlockRecipes: any | null = null;

  constructor(public readonly bot: Bot) {
    this.client = this.bot._client;
    this.bot._client.on('login', (packet) => this.rawLoginPacket = packet)
    this.bot._client.on('declare_commands', (packet) => this.rawCommandPacket = packet)
    this.bot._client.on('tags', (packet) => this.rawTags = packet)
    this.bot._client.on('unlock_recipes', (packet) => this.rawUnlockRecipes = packet)
    this.bot._client.on('declare_recipes', (packet) => this.rawRecipes = packet)
  }

  onCToSPacket(name: string, data: any) {
    switch (name) {
      case 'position':
        this.bot.entity.position.x = data.x;
        this.bot.entity.position.y = data.y;
        this.bot.entity.position.z = data.z;
        this.bot.entity.onGround = data.onGround;
        this.bot.emit('move', this.bot.entity.position); // If bot is not in control physics are turned off
        break;
      case 'position_look': // FALLTHROUGH
        this.bot.entity.position.x = data.x;
        this.bot.entity.position.y = data.y;
        this.bot.entity.position.z = data.z;
      case 'look':
        this.bot.entity.yaw = ((180 - data.yaw) * Math.PI) / 180;
        this.bot.entity.pitch = -(data.pitch * Math.PI) / 180;
        this.bot.entity.onGround = data.onGround;
        this.bot.emit('move', this.bot.entity.position); // If bot is not in control physics are turned off
        break;
      case 'held_item_slot':
        this.bot.quickBarSlot = data.slotId; // C -> S is slotId S -> C is slot !!!
        this.bot._client.emit('mcproxy:heldItemSlotUpdate'); // lol idk how to do it better
        break;
      case 'abilities':
        this.flying = !!((data.flags & 0b10) ^ 0b10);
    }
  }
}

/**
 * Not particularly performant, but that's fine.
 *
 * If necessary, simply condense clientDefaults into clientSpecific. Separated for ease-of-use.
 */
export class MiddlewareHandler {
  clientDefaults: PacketMiddleware[];
  serverDefaults: PacketMiddleware[];

  clientSpecific: Record<string, PacketMiddleware[]> = {};
  serverSpecific: Record<string, PacketMiddleware[]> = {};

  clientExclusion: Record<string, PacketMiddleware[]> = {};
  serverExclusion: Record<string, PacketMiddleware[]> = {};

  onReceive: PacketMiddleware[];
  onSend: PacketMiddleware[];

  constructor(
    opts: MiddlewareHandlerOpts = {}
  ) {
    this.clientDefaults = opts.client || [];
    this.serverDefaults = opts.server || [];
    this.onReceive = opts.onRecieve || [];
    this.onSend = opts.onSend || [];
  }

  register(client: Client, toClient?: PacketMiddleware[], toServer?: PacketMiddleware[]) {
    if (toClient)
      if (this.clientSpecific[client.uuid]) this.clientSpecific[client.uuid].concat(...toClient);
      else this.clientSpecific[client.uuid] = toClient;

    if (toServer)
      if (this.serverSpecific[client.uuid]) this.serverSpecific[client.uuid].concat(...toServer);
      else this.serverSpecific[client.uuid] = toServer;
  }

  removeMiddlewares(client: Client, toClient?: PacketMiddleware[], toServer?: PacketMiddleware[]) {
    if (toClient)
      for (const val of toClient) {
        if (this.clientDefaults.includes(val)) this.clientExclusion[client.uuid].push(val);
        const idx = this.clientSpecific[client.uuid].findIndex((v) => v === val);
        if (idx >= 0) this.clientSpecific[client.uuid].splice(idx, 1);
      }

    if (toServer)
      for (const val of toServer) {
        if (this.serverDefaults.includes(val)) this.serverExclusion[client.uuid].push(val);
        const idx = this.serverSpecific[client.uuid].findIndex((v) => v === val);
        if (idx >= 0) this.serverSpecific[client.uuid].splice(idx, 1);
      }
  }

  removeToClient(client: Client, ...toClient: PacketMiddleware[]) {
    this.removeMiddlewares(client, toClient);
  }

  removeToServer(client: Client, ...toServer: PacketMiddleware[]) {
    this.removeMiddlewares(client, undefined, toServer);
  }

  /**
   * Simply clears memory of client inside handler.
   * @param client
   */
  drop(client: Client) {
    delete this.clientSpecific[client.uuid];
    delete this.serverSpecific[client.uuid];
  }

  *getToClient(client: Client) {
    for (const val of this.clientDefaults) yield val;
    if (this.clientSpecific[client.uuid]) for (const val of this.clientSpecific[client.uuid]) yield val;
    return;
  }

  *getToServer(client: Client) {
    for (const val of this.serverDefaults) yield val;
    if (this.serverSpecific[client.uuid]) for (const val of this.serverSpecific[client.uuid]) yield val;
    return;
  }

  async process(toClient: boolean, client: Client, currentPacket: PacketData) {
    let returnValue: PacketMiddlewareReturnValue;
    let currentData: unknown = currentPacket.data;
    let isCanceled = false;
    let wasChanged = false;
    const gen = toClient ? this.getToClient(client) : this.getToServer(client);
    for (const middleware of gen) {
      const funcReturn = middleware(currentPacket);
      returnValue = funcReturn instanceof Promise ? await funcReturn : funcReturn;

      // Cancel the packet if the return value is false. If the packet is already canceled it can be un canceled with true
      isCanceled = isCanceled ? returnValue !== true : returnValue === false;
      if (returnValue !== undefined && returnValue !== false && returnValue !== true) {
        currentData = returnValue;
        wasChanged = true;
      }
    }
    return {
      wasChanged,
      isCanceled,
      currentData,
    };
  }
}

export class Conn {
  stateData: NewStateData;
  middleware: MiddlewareHandler;
  _controllingClient: Client | null = null;
  _connectedClients: Client[] = [];

  optimizePacketWrite: boolean = true;

  toServerInternal: PacketMiddleware;
  toBotInternal: PacketMiddleware;

  /*
   * Exposing these three methods because I access them in other ways
   */
  write: (name: string, data: any) => void;
  writeRaw: (buffer: any) => void;
  writeChannel: (channel: any, params: any) => void;

  get bot() {
    return this.stateData.bot;
  }

  get client() {
    return this.stateData.client;
  }

  get controllingClient() {
    return this._controllingClient;
  }

  get connectedClients() {
    return this._connectedClients;
  }

  constructor(bOpts: BotOptions, mOpts: MiddlewareHandlerOpts = {}) {
    const bot = createBot(bOpts);
    this.stateData = new NewStateData(bot);
    this.middleware = new MiddlewareHandler(mOpts);
    this.write = this.client.write.bind(this.client);
    this.writeRaw = this.client.writeRaw.bind(this.client);
    this.writeChannel = this.client.writeChannel.bind(this.client);

    this.toBotInternal = this.getServerToBotMiddleware();
    this.toServerInternal = this.getBotToServerMiddleware();
  }

  static writeTo(pclient: Client, name: string, data: any) {
    pclient.write(name, data);

    // TODO: make this robust.
    if (Number(pclient.version.split(" ")?.[1]) >= 19)
      if (pclient.lastDelimiter++ > 20) {
        pclient.lastDelimiter = 0;
        pclient.write("bundle_delimiter", {});
      }
  }

  static writeRawTo(pclient: Client, buffer: Buffer) {
    pclient.writeRaw(buffer);

    // TODO: make this robust.
    if (Number(pclient.version.split(" ")?.[1]) >= 19)
      if (pclient.lastDelimiter++ > 20) {
        pclient.lastDelimiter = 0;
        pclient.write("bundle_delimiter", {});
      }
  }

  async writeIf(name: string, packetData: any) {
    console.log(name)
    const state = this.client.state;
    // Build packet canceler function used by middleware

    let data: PacketMiddlewareReturnValue = packetData;
    const funcReturn = this.toServerInternal({
      bound: "server",
      meta: { state, name },
      writeType: "packet",
      data: packetData,
      pclient: null,
      isCanceled: false,
    });
    data = funcReturn instanceof Promise ? await funcReturn : funcReturn;
    if (data === false) return console.log('canceled', name);

    if (data === undefined) {  console.log(name, packetData); this.write(name, packetData);}
    else { console.log(name, data); this.write(name, data);}
  }

  private getBotToServerMiddleware(): PacketMiddleware {
    const packetWhitelist = ["keep_alive"]; // Packets that are send to the server even tho the bot is not controlling
    return ({ meta }) => {
      // return undefined;
      if (packetWhitelist.includes(meta.name)) return undefined;
      return this._controllingClient === undefined ? undefined : false;
    };
  }

  private getServerToBotMiddleware(): PacketMiddleware {
    return () => {
      // Do not cancel on incoming packets to keep the bot updated
      return undefined;
    };
  }

  /**
   * Called when the proxy bot receives a packet from the server. Forwards the packet to all attached and receiving clients taking
   * attached middleware's into account.
   * @param buffer Buffer
   * @param meta
   * @returns
   */
  async onServerRaw(buffer: Buffer, meta: PacketMeta) {
    if (meta.state !== "play") return;

    let _packetData: any | undefined = undefined;
    const getPacketData = () => {
      if (!_packetData) {
        _packetData = this.client.deserializer.parsePacketBuffer(buffer).data.params;
      }
      return _packetData;
    };

    //* keep mineflayer info up to date
    switch (meta.name) {
      case "abilities":
        let packetData = getPacketData();
        this.stateData.flying = !!((packetData.flags & 0b10) ^ 0b10);
        this.stateData.bot.physicsEnabled = !this._controllingClient && this.stateData.flying;
    }

    for (const pclient of this._connectedClients) {
      if (pclient.state !== states.PLAY || meta.state !== states.PLAY) {
        continue;
      }

      let packetData: PacketData = {
        bound: "client",
        meta,
        writeType: "packet",
        pclient,
        data: getPacketData(),
        isCanceled: false,
      };

      // current data is the last middleware's return value.
      const { wasChanged, isCanceled, currentData } = await this.middleware.process(true , pclient, packetData);
      if (isCanceled) continue;

      // Workaround for broken custom_payload packets
      if (meta.name === "custom_payload") return Conn.writeRawTo(pclient, buffer);

      if (!wasChanged && this.optimizePacketWrite) Conn.writeRawTo(pclient, buffer);
      else Conn.writeTo(pclient, meta.name, currentData);
    }
  }

  /**
   * Handles packets send by a client to a server taking attached middleware's into account.
   * @param data Packet data
   * @param meta Packet Meta
   * @param pclient Sending Client
   */
  onClientPacket(pclient: Client, data: any, meta: PacketMeta, buffer: Buffer) {
    console.log(meta)
    if (meta.state !== "play") return;
    const handle = async () => {
      let packetData: PacketData = {
        bound: "server",
        meta,
        writeType: "packet",
        pclient,
        data,
        isCanceled: false,
      };
      const { wasChanged, isCanceled, currentData } = await this.middleware.process(false, pclient, packetData);
      if (isCanceled) return;
      if (meta.name === "custom_payload") return this.writeRaw(buffer);

      if (!wasChanged && this.optimizePacketWrite) this.writeRaw(buffer);
      else this.write(meta.name, currentData);
    };
    handle().catch(console.error); // yikes.
  }

  /**
   * Generate the login sequence off packets for a client from the current bot state. Can take the client as an optional
   * argument to customize packets to the client state like version but is not used at the moment and defaults to 1.12.2
   * generic packets.
   * @param pclient Optional. Does nothing.
   */
  *generateSyncPackets(pclient?: Client): Generator<Packet, void, unknown> {
    for (const val of generatePackets(this.stateData as any, pclient)) yield val;
  }

  syncToRemote(pclient: Client) {
    for (const p of this.generateSyncPackets(pclient)) pclient.write(...p);
  }

  /**
   * Attaches a client to the proxy. Attaching means receiving all packets from the server. Takes middleware handlers
   * as an optional argument to be used for the client.
   * @param pclient
   * @param options
   */
  attach(pclient: Client, toClient?: PacketMiddleware[], toServer?: PacketMiddleware[]) {
    if (!this._connectedClients.includes(pclient)) {
      if (pclient.lastDelimiter === undefined) pclient.lastDelimiter = 0;
      // this.clientServerDefaultMiddleware(pclient);
      // this.serverClientDefaultMiddleware(pclient);
      this._connectedClients.push(pclient);
      const packetListener = this.onClientPacket.bind(this, pclient);
      const cleanup = () => {
        pclient.removeListener("packet", packetListener);
      };
      pclient.on("packet", packetListener);
      pclient.once("mcproxy:detach", cleanup);
      pclient.once("end", () => {
        cleanup();
        this.detach(pclient);
      });

      this.middleware.register(pclient, toClient, toServer);
    }
  }

  /**
   * Reverse attaching
   * a client that isn't attached anymore will no longer receive packets from the server.
   * if the client was the writing client, it will also be unlinked.
   * @param pClient Client to detach
   */
  detach(pClient: Client) {
    this._connectedClients = this._connectedClients.filter((c) => c !== pClient);
    pClient.emit("mcproxy:detach");
    if (this._controllingClient === pClient) this.unlink();
  }

  /**
   * Linking means being the one client on the connection that is able to write to the server replacing the bot or other
   * connected clients that are currently writing.
   * If not previously attached, this will do so.
   * @param pClient Client to link
   * @param options Extra options like extra middleware to be used for the client.
   */
  link(pClient: Client, toClient?: PacketMiddleware[], toServer?: PacketMiddleware[]) {
    if (this._controllingClient) this.unlink(); // Does this even matter? Maybe just keep it for future use when unlink does more.
    this._controllingClient = pClient;
    this.stateData.bot.physicsEnabled = false;
    this.client.write = this.writeIf.bind(this);
    this.client.writeRaw = () => {};
    this.client.writeChannel = () => {};
    this.attach(pClient, toClient, toServer);
  }

  /**
   * Reverse linking.
   * Doesn't remove the client from the receivingClients array, it is still attached.
   */
  unlink() {
    if (this._controllingClient) {
      this.stateData.bot.physicsEnabled = this.stateData.flying;
      this.client.write = this.write.bind(this.client);
      this.client.writeRaw = this.writeRaw.bind(this.client);
      this.client.writeChannel = this.writeChannel.bind(this.client);
      this._controllingClient = null;
    }
  }

    //* disconnect from the server and ends, detaches all pclients
    disconnect() {
      this.stateData.bot._client.end("conn: disconnect called");
      this._connectedClients.forEach(this.detach.bind(this));
    }
}

export class OldConn {
  options: ConnOptions;
  stateData: StateData;
  client: mcpClient;
  /** @deprecated Use `Conn.stateData.bot` instead */
  bot: Bot;
  /** Internal whitelist for the bot */
  // private internalWhitelist: string[] = ['keep_alive'];
  optimizePacketWrite: boolean = true;
  /** Contains the currently writing client or undefined if there is none */
  pclient: Client | undefined;
  /** Contains clients that are actively receiving packets from the proxy bot */
  pclients: Client[] = [];
  toClientDefaultMiddleware?: PacketMiddleware[] = undefined;
  toServerDefaultMiddleware?: PacketMiddleware[] = undefined;
  serverToBotDefaultMiddleware: PacketMiddleware;
  botToServerDefaultMiddleware: PacketMiddleware;
  write: (name: string, data: any) => void;
  writeRaw: (buffer: any) => void;
  writeChannel: (channel: any, params: any) => void;
  positionTransformer?: IPositionTransformer = undefined;
  constructor(botOptions: BotOptions, options?: Partial<ConnOptions>) {
    this.options = { ...new ConnOptions(), ...options };
    this.client = createClient(botOptions);
    this.bot = createBot({ ...botOptions, client: this.client });
    this.stateData = new StateData(this.bot);
    this.pclients = [];
    this.serverToBotDefaultMiddleware = this.getServerToBotMiddleware();
    this.botToServerDefaultMiddleware = this.getBotToServerMiddleware();
    this.write = this.client.write.bind(this.client);
    this.writeRaw = this.client.writeRaw.bind(this.client);
    this.writeChannel = this.client.writeChannel.bind(this.client);
    this.optimizePacketWrite = this.options.optimizePacketWrite;
    if (options?.toClientMiddleware) this.toClientDefaultMiddleware = options.toClientMiddleware;
    if (options?.toServerMiddleware) this.toServerDefaultMiddleware = options.toServerMiddleware;

    if (options?.positionTransformer) {
      if (options.positionTransformer instanceof Vec3) {
        this.positionTransformer = new SimplePositionTransformer(
          options.positionTransformer
            .scaled(1 / 16)
            .floor()
            .scale(16)
        );
      } else {
        this.positionTransformer = options.positionTransformer;
      }
    }

    this.client.on("raw", this.onServerRaw.bind(this));
  }

  static writeTo(pclient: Client, name: string, data: any) {
    pclient.write(name, data);
    if (pclient.lastDelimiter++ > 20) {
      // console.info('Delimiter reset')
      pclient.lastDelimiter = 0;
      // pclient.write('bundle_delimiter', { });
    }
  }

  static writeRawTo(pclient: Client, buffer: Buffer) {
    pclient.writeRaw(buffer);
    if (pclient.lastDelimiter++ > 20) {
      // console.info('Delimiter reset')
      pclient.lastDelimiter = 0;
      // pclient.write('bundle_delimiter', { });
    }
  }

  /**
   * Called when the proxy bot receives a packet from the server. Forwards the packet to all attached and receiving clients taking
   * attached middleware's into account.
   * @param buffer Buffer
   * @param meta
   * @returns
   */
  async onServerRaw(buffer: Buffer, meta: PacketMeta) {
    if (meta.state !== "play") return;

    let _packetData: any | undefined = undefined;
    const getPacketData = () => {
      if (!_packetData) {
        _packetData = this.client.deserializer.parsePacketBuffer(buffer).data.params;
      }
      return _packetData;
    };

    //* keep mineflayer info up to date
    switch (meta.name) {
      case "abilities":
        let packetData = getPacketData();
        this.stateData.flying = !!((packetData.flags & 0b10) ^ 0b10);
        this.stateData.bot.physicsEnabled = !this.pclient && this.stateData.flying;
    }
    for (const pclient of this.pclients) {
      if (pclient.state !== states.PLAY || meta.state !== states.PLAY) {
        continue;
      }

      let packetData: PacketData = {
        bound: "client",
        meta,
        writeType: "packet",
        pclient,
        data: {},
        isCanceled: false,
      };
      let wasChanged = false;
      // let isCanceled = false;
      Object.defineProperties(packetData, {
        data: {
          get: () => {
            wasChanged = true;
            return getPacketData();
          },
        },
      });
      const { isCanceled, currentData } = await this.processMiddlewareList(pclient.toClientMiddlewares, packetData);
      if (isCanceled) continue;
      if (meta.name === "custom_payload") {
        // Workaround for broken custom_payload packets
        Conn.writeRawTo(pclient, buffer);
        return;
      }
      if (!wasChanged && this.optimizePacketWrite) {
        Conn.writeRawTo(pclient, buffer);
        continue;
      }
      Conn.writeTo(pclient, meta.name, currentData);
    }
  }

  /**
   * Handles packets send by a client to a server taking attached middleware's into account.
   * @param data Packet data
   * @param meta Packet Meta
   * @param pclient Sending Client
   */
  onClientPacket(data: any, meta: PacketMeta, buffer: Buffer, pclient: Client) {
    if (meta.state !== "play") return;
    const handle = async () => {
      let packetData: PacketData = {
        bound: "server",
        meta,
        writeType: "packet",
        pclient,
        data,
        isCanceled: false,
      };
      let wasChanged = false;
      Object.defineProperties(packetData, {
        data: {
          get: () => {
            wasChanged = true;
            return data;
          },
        },
      });
      const { isCanceled, currentData } = await this.processMiddlewareList(pclient.toServerMiddlewares, packetData);
      if (isCanceled) return;
      if (meta.name === "custom_payload") {
        // Workaround for broken custom_payload packets
        this.writeRaw(buffer);
        return;
      }
      if (!wasChanged && this.optimizePacketWrite) {
        this.writeRaw(buffer);
        return;
      }
      this.write(meta.name, currentData);
    };
    handle().catch(console.error);
  }

  /**
   * Register middleware to be used as client to server middleware.
   * @param pclient Client
   */
  private serverClientDefaultMiddleware(pclient: Client) {
    if (!pclient.toClientMiddlewares) pclient.toClientMiddlewares = [];
    const _internalMcProxyServerClient: PacketMiddleware = () => {
      if (!this.pclients.includes(pclient)) return false;
    };
    if (this.positionTransformer) {
      const transformer = this.positionTransformer;
      const _internalMcProxyServerClientCoordinatesSpoof: PacketMiddleware = (packetData) => {
        const transformedData = transformer.onSToCPacket(packetData.meta.name, packetData.data);
        const name = packetData.meta.name;
        if (!transformedData) return false;
        if (transformedData.length > 1) {
          transformedData.forEach((packet) => {
            packetData.pclient && Conn.writeTo(packetData.pclient, packet[0], packet[1]);
          });
          return false;
        }
        return transformedData[0][1];
      };
      pclient.toClientMiddlewares.push(_internalMcProxyServerClientCoordinatesSpoof);
    }
    pclient.toClientMiddlewares.push(_internalMcProxyServerClient);
    if (this.toClientDefaultMiddleware) pclient.toClientMiddlewares.push(...this.toClientDefaultMiddleware);
  }

  /**
   * Register the default (first) middleware used to control what client can interact with the current bot.
   * @param pclient Client
   */
  private clientServerDefaultMiddleware(pclient: Client) {
    if (!pclient.toServerMiddlewares) pclient.toServerMiddlewares = [];
    const transformer = this.positionTransformer;
    const _internalMcProxyClientServer: PacketMiddleware = ({ meta, data }) => {
      if (meta.state !== "play") return false;
      if (meta.name === "teleport_confirm" && data?.teleportId === 0) {
        let toSendPos: any = this.stateData.bot.entity.position;
        if (transformer) {
          const p = this.stateData.bot.entity.position;
          toSendPos = transformer.sToC.offsetXYZ(p.x, p.y, p.z);
        }
        Conn.writeTo(pclient, "position", {
          ...toSendPos,
          yaw: 180 - (this.stateData.bot.entity.yaw * 180) / Math.PI,
          pitch: -(this.stateData.bot.entity.pitch * 180) / Math.PI,
          teleportId: 1,
        });
        return false;
      }
      //* check if client is authorized to modify connection (sending packets and state information from mineflayer)
      if (this.pclient !== pclient) {
        return false;
      }
      // Keep the bot updated from packets that are send by the controlling client to the server
      if (transformer) {
        const offsetData = transformer.onCToSPacket(meta.name, data);
        this.stateData.onCToSPacket(meta.name, offsetData);
      } else {
        this.stateData.onCToSPacket(meta.name, data);
      }
      if (meta.name === "keep_alive") return false; // Already handled by the bot client
    };
    pclient.toServerMiddlewares.push(_internalMcProxyClientServer.bind(this));
    if (this.positionTransformer) {
      const transformer = this.positionTransformer;
      const _internalMcProxyClientServerCoordinatesSpoof: PacketMiddleware = (packetData) => {
        const transformedData = transformer.onCToSPacket(packetData.meta.name, packetData.data);
        if (transformedData) return transformedData;
        return false;
      };
      pclient.toServerMiddlewares.push(_internalMcProxyClientServerCoordinatesSpoof);
    }
    if (this.toServerDefaultMiddleware) pclient.toServerMiddlewares.push(...this.toServerDefaultMiddleware);
  }

  private getBotToServerMiddleware(): PacketMiddleware {
    const packetWhitelist = ["keep_alive"]; // Packets that are send to the server even tho the bot is not controlling
    return ({ meta }) => {
      if (packetWhitelist.includes(meta.name)) return undefined;
      return this.pclient === undefined ? undefined : false;
    };
  }

  private getServerToBotMiddleware(): PacketMiddleware {
    return () => {
      // Do not cancel on incoming packets to keep the bot updated
      return undefined;
    };
  }

  /**
   * Send all packets to a client that are required to login to a server.
   * @param pclient
   */
  sendPackets(pclient: Client) {
    for (const packet of this.generatePackets(pclient)) {
      pclient.write(...packet);
    }
  }

  /**
   * Generate the login sequence off packets for a client from the current bot state. Can take the client as an optional
   * argument to customize packets to the client state like version but is not used at the moment and defaults to 1.12.2
   * generic packets.
   * @param pclient Optional. Does nothing.
   */
  *generatePackets(pclient?: Client): Generator<Packet, void, unknown> {
    if (this.positionTransformer) {
      const transformer = this.positionTransformer;
      const packets: Packet[] = [];
      const offset = {
        offsetBlock: this.positionTransformer.sToC.offsetVec,
        offsetChunk: this.positionTransformer.sToC.offsetChunkVec,
      };
      for (const generatedPacket of generatePackets(this.stateData, pclient, offset)) {
        const [name, data] = generatedPacket;
        if (name === "map_chunk" || name === "tile_entity_data") {
          // TODO: move offsetting into generatePackets
          yield generatedPacket;
          // continue
        }
        const transformedData = transformer.onSToCPacket(name, data);
        if (!transformedData) continue;
        for (const val of transformedData) yield val;
      }
    } else {
      for (const val of generatePackets(this.stateData, pclient)) yield val;
    }
  }

  /**
   * Attaches a client to the proxy. Attaching means receiving all packets from the server. Takes middleware handlers
   * as an optional argument to be used for the client.
   * @param pclient
   * @param options
   */
  attach(
    pclient: Client,
    options?: { toClientMiddleware?: PacketMiddleware[]; toServerMiddleware?: PacketMiddleware[] }
  ) {
    if (!this.pclients.includes(pclient)) {
      if (pclient.lastDelimiter === undefined) pclient.lastDelimiter = 0;
      this.clientServerDefaultMiddleware(pclient);
      this.serverClientDefaultMiddleware(pclient);
      this.pclients.push(pclient);
      const packetListener = (data: any, meta: PacketMeta, buffer: Buffer) =>
        this.onClientPacket(data, meta, buffer, pclient);
      const cleanup = () => {
        pclient.removeListener("packet", packetListener);
      };
      pclient.on("packet", packetListener);
      pclient.once("mcproxy:detach", () => cleanup());
      pclient.once("end", () => {
        cleanup();
        this.detach(pclient);
      });
      // setInterval(() => { // TODO: remove this but be warned this will break everything or break nothing idfk
      //   Conn.writeTo(pclient, 'bundle_delimiter', { })
      // }, 1000)
      if (options?.toClientMiddleware) pclient.toClientMiddlewares.push(...options.toClientMiddleware);
      if (options?.toServerMiddleware) {
        pclient.toServerMiddlewares.push(...options.toServerMiddleware);
      }
    }
  }

  /**
   * Reverse attaching
   * a client that isn't attached anymore will no longer receive packets from the server.
   * if the client was the writing client, it will also be unlinked.
   * @param pClient Client to detach
   */
  detach(pClient: Client) {
    this.pclients = this.pclients.filter((c) => c !== pClient);
    pClient.emit("mcproxy:detach");
    if (this.pclient === pClient) this.unlink();
  }

  /**
   * Linking means being the one client on the connection that is able to write to the server replacing the bot or other
   * connected clients that are currently writing.
   * If not previously attached, this will do so.
   * @param pClient Client to link
   * @param options Extra options like extra middleware to be used for the client.
   */
  link(
    pClient: Client,
    options?: { toClientMiddleware?: PacketMiddleware[]; toServerMiddleware?: PacketMiddleware[] }
  ) {
    if (this.pclient) this.unlink(); // Does this even matter? Maybe just keep it for future use when unlink does more.
    this.pclient = pClient;
    this.stateData.bot.physicsEnabled = false;
    this.client.write = this.writeIf.bind(this);
    this.client.writeRaw = () => {};
    this.client.writeChannel = () => {};
    this.attach(pClient, options);
  }

  /**
   * Reverse linking.
   * Doesn't remove the client from the receivingClients array, it is still attached.
   */
  unlink() {
    if (this.pclient) {
      this.stateData.bot.physicsEnabled = this.stateData.flying;
      this.client.write = this.write.bind(this.client);
      this.client.writeRaw = this.writeRaw.bind(this.client);
      this.client.writeChannel = this.writeChannel.bind(this.client);
      this.pclient = undefined;
    }
  }

  //* internal filter
  async writeIf(name: string, packetData: any) {
    // if (this.internalWhitelist.includes(name)) this.write(name, data);

    const state = this.client.state;
    // Build packet canceler function used by middleware

    let data: PacketMiddlewareReturnValue = packetData;
    const funcReturn = this.botToServerDefaultMiddleware({
      bound: "server",
      meta: { state, name },
      writeType: "packet",
      data: packetData,
      pclient: null,
      isCanceled: false,
    });
    if (funcReturn instanceof Promise) {
      data = await funcReturn;
    } else {
      data = funcReturn;
    }
    const isCanceled = data === false;
    if (isCanceled) return console.log('canceled');

    if (data === undefined) {
      console.log(name, packetData)
      this.write(name, packetData);
    } else {
      console.log(name, data)
      this.write(name, data);
    }
  }
  //* disconnect from the server and ends, detaches all pclients
  disconnect() {
    this.stateData.bot._client.end("conn: disconnect called");
    this.pclients.forEach(this.detach.bind(this));
  }

  async processMiddlewareList(middlewareList: PacketMiddleware[], currentPacket: PacketData) {
    let returnValue: PacketMiddlewareReturnValue;
    let currentData: unknown = currentPacket.data;
    let isCanceled = false;
    for (const middleware of middlewareList) {
      const funcReturn = middleware(currentPacket);
      if (funcReturn instanceof Promise) {
        returnValue = await funcReturn;
      } else {
        returnValue = funcReturn;
      }
      // Cancel the packet if the return value is false. If the packet is already canceled it can be un canceled with true
      isCanceled = isCanceled ? returnValue !== true : returnValue === false;
      if (returnValue !== undefined && returnValue !== false && returnValue !== true) {
        currentData = returnValue;
      }
    }
    return {
      isCanceled,
      currentData,
    };
  }
}
