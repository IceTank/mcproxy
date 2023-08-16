Error.stackTraceLimit = 30;
import type { Bot, Player } from "mineflayer";
import type { Client, Packet } from "./conn";
import { SmartBuffer } from "smart-buffer";
import vec3Builder, { Vec3 } from "vec3";
import { StateData } from "./stateData";
import { Entity } from "prismarine-entity";
import deepcopy from "deepcopy";
import * as fs from "fs";

const MAX_CHUNK_DATA_LENGTH = 31598;

function entityYawToIntPacket(num: number) {
  return -(Math.floor(((num / Math.PI) * 128 + 255) % 256) - 127);
}

function entityPitchToIntPacket(num: number) {
  return -Math.floor(((num / Math.PI) * 128) % 256);
}

export type PacketTuple = {
  name: string;
  data: any;
};

export const dimension: Record<string, number> = {
  "minecraft:end": 1,
  "minecraft:overworld": 0,
  "minecraft:nether": -1,
};

export const gamemode: Record<string, number> = {
  survival: 0,
  creative: 1,
  adventure: 2,
  spectator: 3,
};

export const difficulty: Record<string, number> = {
  peaceful: 0,
  easy: 1,
  normal: 2,
  hard: 3,
};

export function packetAbilities(bot: Bot): any {
  let flags = 0b0;
  if (bot.physicsEnabled && !bot.entity.onGround) flags |= 0b10; // Flying right now
  if ([1, 3].includes(bot.player.gamemode)) flags |= 0b100; // Can fly
  if (bot.player.gamemode === 1) flags |= 0b1000; // Instant break
  return {
    // name: "abilities",
    // data: {
    flags,
    flyingSpeed: 0.05,
    walkingSpeed: 0.1,
    // },
  };
}

export function sendTo(pclient: Client, ...args: PacketTuple[]) {
  for (const a of args) {
    pclient.write(a.name, a.data);
  }
}

export function generatePackets(
  stateData: StateData,
  pclient?: Client,
  offset?: { offsetBlock: Vec3; offsetChunk: Vec3 }
): Packet[] {
  const bot = stateData.bot;
  //* if not spawned yet, return nothing
  if (!bot.entity) return [];

  //* load up some helper methods
  const { toNotch: itemToNotch }: typeof import("prismarine-item").Item = require("prismarine-item")(
    pclient?.version ?? bot.version
  );

  const UUID = bot.player.uuid; //pclient?.uuid ??

  return [
    // store rawLoginPacket since mineflayer does not handle storing data correctly.
    ["login", stateData.rawLoginPacket],

    // unneeded to spawn
    // hardcoded unlocked difficulty because mineflayer doesn't save.
    ["difficulty", { difficulty: bot.game.difficulty, difficultyLocked: false }], //, 

    // unneeded to spawn
    // ability generation seems fine
    ["abilities", { ...packetAbilities(bot) }],

    // unneeded to spawn
    // Updating held item
    ["held_item_slot", { slot: bot.quickBarSlot ?? 1 }],

    // unneeded to spawn
    // declare recipes (requires prismarine-registry)

    // unneeded to spawn
    // load "tags", whatever that is

    // unneeded to spawn
    // temporarily hardcoded
    ["entity_status", { entityId: bot.entity.id, entityStatus: 28 }],

    // unneeded to spawn
    // needed to get commands from server.
    ["declare_commands", stateData.rawCommandPacket],

    // unneeded to spawn
    // unlock recipes

    // NEEDED TO SPAWN
    // Update position of entity
    [
      "position",
      {
        ...bot.entity.position,
        yaw: 180 - (bot.entity.yaw * 180) / Math.PI,
        pitch: -(bot.entity.pitch * 180) / Math.PI,
        flags: 0,
        teleportId: 1,
      },
    ],

    // unneeded to spawn
    // get server motd & enforceChatShit
    // NOTE: we should probably intercept this packet and store since, well, MOTD isn't stored by minecraft-protocol
    // [
    //   "server_data",
    //   {
    //     motd: '{"text":"lmao placeholder"}',
    //     enforcesSecureChat: (bot._client as any).serverFeatures.enforcesSecureChat,
    //   },
    // ],

    // unneeded to spawn
    // fills in tablist and other info
    // Spawns in named entities and players.
    ...convertPlayers(bot.players, UUID),

    // unneeded to spawn
    // set time to remote bot's
    // 1.12.2 requires not bigInt, 1.20 does.
    ["update_time", { age: bot.time.bigAge, time: bot.time.bigTime }],

    // // spawn position
    [ "spawn_position", { location: { x: 0, z: -64, y: 73 }, angle: 0 }],

    // unneeded to spawn
    // set view pos to chunk we're spawning in
    // ["update_view_position", { chunkX: Math.floor(bot.entity.position.x) >> 4, chunkZ: Math.floor(bot.entity.position.z) >> 4 }],

    ...convertWorld(bot.world),

    // // unneeded for spawn
    // // set items to remote bot's
    [
      "window_items",
      {
        windowId: 0,
        statId: 1,
        items: bot.inventory.slots.map((item: any) => itemToNotch(item)),
        carriedItem: { present: false },
      },
    ],

    //? `world_border` (as of 1.12.2) => really needed?
    ...spawnEntities(bot, itemToNotch),

    // ...(bot.isRaining ? [['game_state_change', { reason: 1, gameMode: 0 }]] : []),
    // ...((bot as any).rainState !== 0 ? [['game_state_change', { reason: 7, gameMode: (bot as any).rainState }]] : []),
    // ...((bot as any).thunderState !== 0 ? [['game_state_change', { reason: 8, gameMode: (bot as any).thunderState }]] : []),

    // ! NOTICE !
    // everything afterward is not vanilla, we add to sync.

    // unneeded for spawn
    // NOT VANILLA
    // set gamemode as needed (to match bot?)
    ["game_state_change", { reason: 3, gameMode: bot.player.gamemode }],

    // unneeded for spawn
    // NOT VANILLA
    // set health/food to remote bot's
    ["update_health", { health: bot.health, food: bot.food, foodSaturation: bot.foodSaturation }],
  ] as Packet[];
}

const convertPlayers = (players: Record<string, Player>, UUID: string): Packet[] => {
  const packets: Packet[] = [];
  for (const key in players) {
    const { uuid, username, gamemode, ping, entity } = players[key];
    packets.push([
      // "player_info",
      // {
      //   action: 63,
      //   data: [{ uuid, player: { name: username, properties: [] }, gamemode, latency: ping, listed: true }],
      // },
      "player_info",
      {
        action: 0,
        data: [{ UUID: uuid, name: username, properties: [], gamemode, ping, displayName: undefined }],
      },
    ]);
    if (uuid === UUID) continue; // skip this if its us.
    if (entity) {
      packets.push([
        "named_entity_spawn",
        {
          ...entity.position,
          entityId: entity.id,
          playerUUID: uuid,
          yaw: entityYawToIntPacket(entity.yaw),
          pitch: entityPitchToIntPacket(entity.pitch),
          metadata: (entity as any).rawMetadata,
        },
      ]);
      if ((entity as any).headYaw)
        packets.push([
          "entity_head_rotation",
          {
            entityId: entity.id,
            headYaw: entityYawToIntPacket((entity as any).headYaw),
          },
        ]);
    }
  }

  return packets;
};

const convertWorld = (world: any): Packet[] => {
  const packets: Packet[] = [];
  for (const chunk of world.getColumns()) {
    const data1 = chunk.column.dumpLight();
    const ret: Record<string, any> = {
      x: Number(chunk.chunkX),
      z: Number(chunk.chunkZ),
    };

    ret.blockEntities = [];

    if (!!data1) {
      ret.heightmaps = { type: "compound", name: "", value: {} };

      // if (chunk.column.trustEdges)
      ret.trustEdges = true;
      ret.skyLightMask = data1.skyLightMask;
      ret.blockLightMask = data1.blockLightMask;
      ret.emptySkyLightMask = data1.emptySkyLightMask;
      ret.emptyBlockLightMask = data1.emptyBlockLightMask;
      ret.skyLight = data1.skyLight; // I don't think this is necessary.
      ret.blockLight = data1.blockLight; // I don't think this is necessary.

      if (Object.keys(chunk.column.blockEntities).length) {
        for (const [key, val] of Object.entries<any>(chunk.column.blockEntities)) {
          if (val === undefined) continue;
          if (val.x) ret.blockEntities.push(val);
          else {
            let [x, y, z]: any[] = key.split(",");
            [x, y, z] = [Number(x) & 0xf, Number(y), Number(z) & 0xf]; // https://github.com/PrismarineJS/mineflayer/blob/a16d270ee6d576ae31ddcbe72d6e27e7ec486665/lib/plugins/blocks.js#L300
            ret.blockEntities.push({ x, y, z, nbtData: val });
          }
        }
      }
    } else {
      ret.groundUp = true;
      ret.bitMap = chunk.column.getMask();
      ret.blockEntities = Object.values(chunk.column.blockEntities);
    }

    ret.chunkData = chunk.column.dump();
    packets.push(["map_chunk", ret]);
  }
  return packets;
};

function getMetaArrayForEntity(entity: Entity) {
  const meta = entity.metadata;
  const compArr = [];
  for (let i = 0; i < meta.length; i++) {
    const data = meta[i];
    switch (i) {
      case 0: // On fire crouching etc
        compArr.push({ key: i, type: 0, value: data ? data : 0 });
        break;
      case 1: // Air time
        compArr.push({ key: i, type: 1, value: data ? data : 300 });
        break;
      case 2: // Custom name
        compArr.push({ key: i, type: 3, value: data ? data : "" });
        break;
      case 3: // Custom name visible
        compArr.push({ key: i, type: 6, value: data ? data : false });
        break;
      case 4: // Is silent
        compArr.push({ key: i, type: 6, value: data ? data : false });
        break;
      case 5: // Has no gravity
        compArr.push({ key: i, type: 6, value: data ? data : false });
        break;
      case 6: // Item in item frame?
        compArr.push({ key: i, type: 5, value: data });
    }
  }
  return compArr;
}

const shulkerIds = [219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234];

function toYawWeird(num: number) {
  return -(Math.floor(((num / Math.PI) * 128 + 255) % 256) - 127);
}

export function offsetTileEntityData(originalLocation: Vec3, nbtData: BlockEntityNbt, offset: Vec3) {
  const originalPosition = new Vec3(originalLocation.x, originalLocation.y, originalLocation.z);
  const offsetPosition = originalPosition.minus(offset);
  const nbtDataNew: BlockEntityNbt = {
    type: "compound",
    name: "",
    value: {
      ...nbtData.value,
      x: { type: "int", value: offsetPosition.x },
      y: { type: "int", value: offsetPosition.y },
      z: { type: "int", value: offsetPosition.z },
    },
  };
  return {
    ...nbtData,
    ...nbtDataNew,
  };
}

export function offsetTileEntityPacket(data: any, offset: Vec3): Packet[] {
  const originalPosition = new Vec3(data.location.x, data.location.y, data.location.z);
  return [
    [
      "tile_entity_data",
      {
        ...data,
        location: originalPosition.minus(offset),
        nbtData: offsetTileEntityData(originalPosition, data.nbtData, offset),
      },
    ],
  ] as Packet[];
}

function spawnEntities(bot: Bot, itemToNotch: typeof import("prismarine-item").Item.toNotch) {
  const packets = [];
  for (const entity of Object.values(bot.entities)) {
    switch (entity.type) {
      case "orb":
        packets.push([
          "spawn_entity_experience_orb",
          {
            ...entity.position,
            entityId: entity.id,
            count: entity.count,
          },
        ]);
        break;

      case "mob":
        packets.push(
          [
            "spawn_entity_living",
            {
              ...entity.position,
              entityId: entity.id,
              entityUUID: (entity as any).uuid,
              type: entity.entityType,
              yaw: toYawWeird(entity.yaw),
              pitch: entity.pitch,
              headPitch: (entity as any).headPitch,
              velocityX: entity.velocity.x,
              velocityY: entity.velocity.y,
              velocityZ: entity.velocity.z,
              metadata: (entity as any).rawMetadata,
            },
          ],
          ...entity.equipment.reduce((arr, item, slot) => {
            if (item)
              arr.push([
                "entity_equipment",
                {
                  entityId: entity.id,
                  slot,
                  item: itemToNotch(item),
                },
              ]);
            return arr;
          }, [] as Packet[])
        );
        break;

      case "object":
        packets.push([
          "spawn_entity",
          {
            ...entity.position,
            entityId: entity.id,
            objectUUID: (entity as any).uuid,
            type: entity.entityType,
            yaw: toYawWeird(entity.yaw),
            pitch: entity.pitch,
            objectData: (entity as any).objectData,
            velocityX: entity.velocity.x,
            velocityY: entity.velocity.y,
            velocityZ: entity.velocity.z,
          },
        ]);
        if (entity.entityType === 71 && entity.metadata) {
          // Special fix for item frames
          packets.push([
            "entity_metadata",
            {
              entityId: entity.id,
              metadata: getMetaArrayForEntity(entity),
            },
          ]);
        }
        break;

      default:
        //TODO add more?
        break;
    }
    if ((entity as any).rawMetadata?.length > 0)
      packets.push([
        "entity_metadata",
        {
          entityId: entity.id,
          metadata: (entity as any).rawMetadata,
        },
      ]);
  }
  return packets;
}

type NbtPositionTag = { type: "int"; value: number };
export type BlockEntityNbt = {
  type: "compound";
  name: "";
  value: { x: NbtPositionTag; y: NbtPositionTag; z: NbtPositionTag; id: { type: "string"; value: string } };
};
export type TileEntityPacket = {
  location: { x: number; y: number; z: number };
  action: number;
  nbtData: BlockEntityNbt;
};
//* splits a single chunk column into multiple packets if needed
export function chunkColumnToPacketsWithOffset(
  { chunkX: x, chunkZ: z, column }: { chunkX: number; chunkZ: number; column: any },
  lastBitMask?: number,
  chunkDataArg?: SmartBuffer,
  chunkEntities: BlockEntityNbt[] = [],
  offset?: { offsetBlock: Vec3; offsetChunk: Vec3 }
): Packet[] {
  let bitMask = !!lastBitMask ? column.getMask() ^ (column.getMask() & ((lastBitMask << 1) - 1)) : column.getMask();
  let bitMap = lastBitMask ?? 0b0;
  let newChunkData = new SmartBuffer();
  const realOffset = offset ?? { offsetBlock: new Vec3(0, 0, 0), offsetChunk: new Vec3(0, 0, 0) };
  let chunkData = chunkDataArg ?? new SmartBuffer();

  // checks with bitmask if there is a chunk in memory that (a) exists and (b) was not sent to the client yet
  for (let i = 0; i < 16; i++)
    if (bitMask & (0b1 << i)) {
      column.sections[i].write(newChunkData);
      bitMask ^= 0b1 << i;
      if (chunkData.length + newChunkData.length > MAX_CHUNK_DATA_LENGTH) {
        if (!lastBitMask) column.biomes?.forEach((biome: number) => chunkData.writeUInt8(biome));
        return [
          [
            "map_chunk",
            {
              x: x - realOffset.offsetChunk.x,
              z: z - realOffset.offsetChunk.z,
              bitMap,
              chunkData: chunkData.toBuffer(),
              groundUp: !lastBitMask,
              blockEntities: chunkDataArg
                ? []
                : Object.entries(column.blockEntities).map((data) => {
                    const nbtData: BlockEntityNbt = data[1] as unknown as BlockEntityNbt;
                    const originalLocation = new Vec3(
                      nbtData.value.x.value,
                      nbtData.value.y.value,
                      nbtData.value.z.value
                    );
                    return offsetTileEntityData(originalLocation, nbtData, realOffset.offsetBlock);
                  }),
            },
          ],
          ...chunkColumnToPacketsWithOffset(
            { chunkX: x, chunkZ: z, column },
            0b1 << i,
            newChunkData,
            undefined,
            offset
          ),
          // ...getChunkEntityPacketsWithOffset(column, column.blockEntities, offset),
        ];
      }
      bitMap ^= 0b1 << i;
      chunkData.writeBuffer(newChunkData.toBuffer());
      newChunkData.clear();
    }
  if (!lastBitMask) column.biomes?.forEach((biome: number) => chunkData.writeUInt8(biome));
  return [
    [
      "map_chunk",
      {
        x: x - realOffset.offsetChunk.x,
        z: z - realOffset.offsetChunk.z,
        bitMap,
        chunkData: chunkData.toBuffer(),
        groundUp: !lastBitMask,
        blockEntities: chunkDataArg
          ? []
          : Object.entries(column.blockEntities).map((data) => {
              const nbtData: BlockEntityNbt = data[1] as unknown as BlockEntityNbt;
              const originalLocation = new Vec3(nbtData.value.x.value, nbtData.value.y.value, nbtData.value.z.value);
              return offsetTileEntityData(originalLocation, nbtData, realOffset.offsetBlock);
            }),
      },
    ] /** ...getChunkEntityPacketsWithOffset(column, column.blockEntities, offset) */,
  ];
}

function getChunkEntityPacketsWithOffset(
  column: any,
  blockEntities: { [pos: string]: BlockEntityNbt },
  offset?: { offsetBlock: Vec3; offsetChunk: Vec3 }
) {
  offset = offset ?? { offsetBlock: new Vec3(0, 0, 0), offsetChunk: new Vec3(0, 0, 0) };
  const packets: Packet[] = [];
  if (Object.values(blockEntities).length)
    console.info(
      "Block entities: ",
      Object.values(blockEntities).map((b) => b.value.id.value)
    );
  for (const nbtData of Object.values(blockEntities)) {
    const locationOriginal = new Vec3(nbtData.value.x.value, nbtData.value.y.value, nbtData.value.z.value);
    const location = locationOriginal.minus(offset.offsetBlock);
    location.y = locationOriginal.y;

    const block = column.getBlock(posInChunk(location));
    let action: number | null = null;
    if (block.type === 138) {
      // Beacon
      action = 3;
    } else if (block.type === 144) {
      // Skull
      action = 4;
    } else if (block.type === 140) {
      // Flower pot
      action = 5;
    } else if (block.type === 176 || block.type === 177) {
      // Wall and standing banner
      action = 6;
    } else if (block.type === 209) {
      // End gateway
      action = 8;
    } else if (block.type === 63 || block.type === 68) {
      // Sign
      action = 9;
    } else if (shulkerIds.includes(block.type)) {
      action = 10;
    } else if (block.type === 26) {
      // Bed
      action = 11;
    }

    if (action !== null) {
      const foo = [
        "tile_entity_data",
        {
          location,
          action: action,
          nbtData: offsetTileEntityData(locationOriginal, nbtData, offset.offsetBlock),
        },
      ] as Packet;
      // console.info('Tile entity packet', foo)
      packets.push(foo);
    } else if (block.type == 54 || block.type === 146) {
      console.info("Chest nbt", nbtData);
      packets.push(["block_action", { location, byte1: 1, byte2: 0, blockId: block.type }]);
    }
  }
  return packets;
}

/**
 * Tile_entity_data action:

1: Set data of a mob spawner (everything except for SpawnPotentials: current delay, min/max delay, mob to be spawned, spawn count, spawn range, etc.)
2: Set command block text (command and last execution status)
3: Set the level, primary, and secondary powers of a beacon
4: Set rotation and skin of mob head
5: Set type of flower in flower pot
6: Set base color and patterns on a banner
7: Set the data for a Structure tile entity (??? what is that?)
8: Set the destination for a end gateway
9: Set the text on a sign
10: Declare a shulker box, no data appears to be sent and the client seems to do fine without this packet. Perhaps it is a leftover from earlier versions?
11: Set the color of a bed

 */

export function chunkColumnToPackets(
  bot: Bot,
  { chunkX, chunkZ, column }: { chunkX: number; chunkZ: number; column: any },
  lastBitMask?: number,
  chunkData: SmartBuffer = new SmartBuffer(),
  chunkEntities: BlockEntityNbt[] = []
) {
  return chunkColumnToPacketsWithOffset({ chunkX, chunkZ, column }, lastBitMask, chunkData, chunkEntities);
}

function posInChunk(pos: Vec3) {
  return new Vec3(Math.floor(pos.x) & 15, Math.floor(pos.y), Math.floor(pos.z) & 15);
}
