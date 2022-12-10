import type { Bot } from 'mineflayer';
import type { Client, Packet } from './conn';
import { SmartBuffer } from 'smart-buffer';
import { Vec3 } from 'vec3';
import { StateData } from './stateData';

const MAX_CHUNK_DATA_LENGTH = 31598;

export type PacketTuple = {
  name: string;
  data: any;
};

export const dimension: Record<string, number> = {
  'minecraft:end': 1,
  'minecraft:overworld': 0,
  'minecraft:nether': -1,
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

export function packetAbilities(bot: Bot): PacketTuple {
  return {
    name: 'abilities',
    data: {
      flags: (bot.physicsEnabled ? 0b0 : 0b10) | ([1, 3].includes(bot.player.gamemode) ? 0b0 : 0b100) | (bot.player.gamemode !== 1 ? 0b0 : 0b1000),
      flyingSpeed: 0.05,
      walkingSpeed: 0.1,
    },
  };
}

export function sendTo(pclient: Client, ...args: PacketTuple[]) {
  for (const a of args) {
    pclient.write(a.name, a.data);
  }
}

export function generatePackets(stateData: StateData, pclient?: Client, offset?: { offsetBlock: Vec3, offsetChunk: Vec3 }): Packet[] {
  const bot = stateData.bot;
  //* if not spawned yet, return nothing
  if (!bot.entity) return [];

  //* load up some helper methods
  const { toNotch: itemToNotch }: typeof import('prismarine-item').Item = require('prismarine-item')(pclient?.version ?? bot.version);
  const UUID = bot.player.uuid; //pclient?.uuid ??

  return [
    [
      'login',
      {
        entityId: bot.entity.id,
        gamemode: bot.player.gamemode,
        dimension: dimension[bot.game.dimension],
        difficulty: difficulty[bot.game.difficulty],
        maxPlayers: bot.game.maxPlayers,
        levelType: bot.game.levelType,
        reducedDebugInfo: false,
      },
    ],
    [
      'respawn',
      {
        gamemode: bot.player.gamemode,
        dimension: dimension[bot.game.dimension],
        difficulty: difficulty[bot.game.difficulty],
        levelType: bot.game.levelType,
      },
    ],
    [
      'abilities',
      {
        flags: (bot.physicsEnabled ? 0b0 : 0b10) | ([1, 3].includes(bot.player.gamemode) ? 0b0 : 0b100) | (bot.player.gamemode !== 1 ? 0b0 : 0b1000),
        flyingSpeed: 0.05,
        walkingSpeed: 0.1,
      },
    ],
    ['held_item_slot', { slot: bot.quickBarSlot ?? 1 }],
    //? declare recipes
    //? tags?
    //? entity status theoretically (current animation playing)
    //? commands / add option to provide own commands
    // [
    //   'unlock_recipes', // This seams to break on 2b2t. If we do not filter recipes, we crash the client.
    //   {
    //     action: 0,
    //     craftingBookOpen: false,
    //     filteringCraftable: false,
    //     recipes1: bot.recipes,
    //     recipes2: bot.recipes,
    //   },
    // ],
    //* gamemode
    ['game_state_change', { reason: 3, gameMode: bot.player.gamemode }],
    [
      'update_health',
      {
        health: bot.health,
        food: bot.food,
        foodSaturation: bot.foodSaturation,
      },
    ],
    //* inventory
    [
      'window_items',
      {
        windowId: 0,
        items: bot.inventory.slots.map((item: any) => itemToNotch(item)),
      },
    ],
    [
      'position',
      {
        ...bot.entity.position,
        yaw: 180 - (bot.entity.yaw * 180) / Math.PI,
        pitch: -(bot.entity.pitch * 180) / Math.PI,
      },
    ],
    [
      'spawn_position',
      {
        location: bot.spawnPoint ?? bot.entity.position,
      },
    ],
    //! move playerlist here
    //* player_info (personal)
    //* the client's player_info packet
    [
      'player_info',
      {
        action: 0,
        data: [
          {
            UUID,
            name: bot.username,
            properties: [],
            gamemode: bot.player.gamemode,
            ping: bot.player.ping,
            displayName: undefined,
          },
        ],
      },
    ],
    //* other players' info
    ...Object.values(bot.players).reduce<Packet[]>((packets, { uuid, username, gamemode, ping, entity }) => {
      if (uuid != UUID) {
        packets.push([
          'player_info',
          {
            action: 0,
            data: [{ UUID: uuid, name: username, properties: [], gamemode, ping, displayName: undefined }],
          },
        ]);
        if (entity) {
          packets.push([
            'named_entity_spawn',
            {
              ...entity.position,
              entityId: entity.id,
              playerUUID: uuid,
              yaw: -(Math.floor(((entity.yaw / Math.PI) * 128 + 255) % 256) - 127),
              pitch: -Math.floor(((entity.pitch / Math.PI) * 128) % 256),
              metadata: (entity as any).rawMetadata,
            },
          ]);
          if ((entity as any).headYaw)
            packets.push([
              'entity_head_rotation',
              {
                entityId: entity.id,
                headYaw: -(Math.floor((((entity as any).headYaw / Math.PI) * 128 + 255) % 256) - 127),
              },
            ]);
        }
      }
      return packets;
    }, []),
    ...(bot.world.getColumns() as any[]).reduce<Packet[]>((packets, chunk) => [...packets, ...chunkColumnToPacketsNew(chunk, undefined, undefined, undefined, offset)], []),
    //? `world_border` (as of 1.12.2) => really needed?
    //! block entities moved to chunk packet area
    ...Object.values(bot.entities).reduce<Packet[]>((packets, entity) => {
      switch (entity.type) {
        case 'orb':
          packets.push([
            'spawn_entity_experience_orb',
            {
              ...entity.position,
              entityId: entity.id,
              count: entity.count,
            },
          ]);
          break;

        case 'mob':
          packets.push(
            [
              'spawn_entity_living',
              {
                ...entity.position,
                entityId: entity.id,
                entityUUID: (entity as any).uuid,
                type: entity.entityType,
                yaw: entity.yaw,
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
                  'entity_equipment',
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

        case 'object':
          packets.push([
            'spawn_entity',
            {
              ...entity.position,
              entityId: entity.id,
              objectUUID: (entity as any).uuid,
              type: entity.entityType,
              yaw: entity.yaw,
              pitch: entity.pitch,
              objectData: (entity as any).objectData,
              velocityX: entity.velocity.x,
              velocityY: entity.velocity.y,
              velocityZ: entity.velocity.z,
            },
          ]);
          break;

        default:
          //TODO add more?
          break;
      }
      if ((entity as any).rawMetadata?.length > 0)
        packets.push([
          'entity_metadata',
          {
            entityId: entity.id,
            metadata: (entity as any).rawMetadata,
          },
        ]);
      return packets;
    }, []),
    ...(bot.isRaining ? [['game_state_change', { reason: 1, gameMode: 0 }]] : []),
    ...((bot as any).rainState !== 0 ? [['game_state_change', { reason: 7, gameMode: (bot as any).rainState }]] : []),
    ...((bot as any).thunderState !== 0 ? [['game_state_change', { reason: 8, gameMode: (bot as any).thunderState }]] : []),
  ] as Packet[];
}

type NbtPositionTag = { type: 'int'; value: number };
type BlockEntity = { x: NbtPositionTag; y: NbtPositionTag; z: NbtPositionTag; id: object };
type ChunkEntity = { name: string; type: string; value: BlockEntity };
//* splits a single chunk column into multiple packets if needed
export function chunkColumnToPacketsNew(
  { chunkX: x, chunkZ: z, column }: { chunkX: number; chunkZ: number; column: any },
  lastBitMask?: number,
  chunkData: SmartBuffer = new SmartBuffer(),
  chunkEntities: ChunkEntity[] = [],
  offset?: { offsetBlock: Vec3, offsetChunk: Vec3 }
): Packet[] {
  let bitMask = !!lastBitMask ? column.getMask() ^ (column.getMask() & ((lastBitMask << 1) - 1)) : column.getMask();
  let bitMap = lastBitMask ?? 0b0;
  let newChunkData = new SmartBuffer();
  offset = offset ?? { offsetBlock: new Vec3(0, 0, 0), offsetChunk: new Vec3(0, 0, 0)}

  // blockEntities
  // chunkEntities.push(...Object.values(column.blockEntities as Map<string, ChunkEntity>));

  // checks with bitmask if there is a chunk in memory that (a) exists and (b) was not sent to the client yet
  for (let i = 0; i < 16; i++)
    if (bitMask & (0b1 << i)) {
      column.sections[i].write(newChunkData);
      bitMask ^= 0b1 << i;
      if (chunkData.length + newChunkData.length > MAX_CHUNK_DATA_LENGTH) {
        if (!lastBitMask) column.biomes?.forEach((biome: number) => chunkData.writeUInt8(biome));
        return [
          ['map_chunk', { 
            x: x - offset.offsetChunk.x, 
            z: z - offset.offsetChunk.z, 
            bitMap, chunkData: chunkData.toBuffer(), 
            groundUp: !lastBitMask, blockEntities: [] 
          }],
          ...chunkColumnToPacketsNew({ chunkX: x, chunkZ: z, column }, 0b1 << i, newChunkData, undefined, offset),
          ...getChunkEntityPacketsNew(column, column.blockEntities, offset),
        ];
      }
      bitMap ^= 0b1 << i;
      chunkData.writeBuffer(newChunkData.toBuffer());
      newChunkData.clear();
    }
  if (!lastBitMask) column.biomes?.forEach((biome: number) => chunkData.writeUInt8(biome));
  return [['map_chunk', { 
    x: x - offset.offsetChunk.x, z: z - offset.offsetChunk.z, 
    bitMap, chunkData: chunkData.toBuffer(), groundUp: !lastBitMask, blockEntities: [] 
  }], ...getChunkEntityPacketsNew(column, column.blockEntities, offset)];
}

function getChunkEntityPacketsNew(column: any, blockEntities: { [pos: string]: ChunkEntity }, offset?: { offsetBlock: Vec3, offsetChunk: Vec3 }) {
  offset = offset ?? { offsetBlock: new Vec3(0, 0, 0), offsetChunk: new Vec3(0, 0, 0)}
  const packets: Packet[] = [];
  for (const nbtData of Object.values(blockEntities)) {
    const locationOriginal = new Vec3(nbtData.value.x.value, nbtData.value.y.value, nbtData.value.z.value)
    const location = locationOriginal.minus(offset.offsetBlock)
    location.y = locationOriginal.y

    const offsetNbt: ChunkEntity = {
      ...nbtData,
      value: {
        ...nbtData.value
      }
    }
    offsetNbt.value.id = nbtData.value.id
    offsetNbt.value.x = clonePositionValueNbt(nbtData.value.x)
    offsetNbt.value.y = clonePositionValueNbt(nbtData.value.y)
    offsetNbt.value.z = clonePositionValueNbt(nbtData.value.z)

    offsetNbt.value.x.value = location.x
    offsetNbt.value.y.value = location.y
    offsetNbt.value.z.value = location.z

    const block = column.getBlock(posInChunk(location));
    if (block.type === 138) { // Beacon
      packets.push(['tile_entity_data', { location, nbtData: offsetNbt, action: 3 }]);
    } else if (block.type === 144) { // Skull
      packets.push(['tile_entity_data', { location, nbtData: offsetNbt, action: 4 }]);
    } else if (block.type === 140) { // Flower pot
      packets.push(['tile_entity_data', { location, nbtData: offsetNbt, action: 5 }]);
    } else if (block.type === 176 || block.type === 177) { // Wall and standing banner
      packets.push(['tile_entity_data', { location, nbtData: offsetNbt, action: 6 }]);
    } else if (block.type === 209) { // End gateway
      packets.push(['tile_entity_data', { location, nbtData: offsetNbt, action: 8 }]);
    } else if (block.type === 63 || block.type === 68) { // Sign
      packets.push(['tile_entity_data', { location, nbtData: offsetNbt, action: 9 }]);
    } else if (block.type === 26) { // Bed
      packets.push(['tile_entity_data', { location, nbtData: offsetNbt, action: 11 }]);
    } else {
      packets.push(['tile_entity_data', { location, nbtData: offsetNbt }])
    }
    if (block?.name == 'minecraft:chest') {
      packets.push(['block_action', { location, byte1: 1, byte2: 0, blockId: block.type }]);
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
  { chunkX: x, chunkZ: z, column }: { chunkX: number; chunkZ: number; column: any },
  lastBitMask?: number,
  chunkData: SmartBuffer = new SmartBuffer(),
  chunkEntities: ChunkEntity[] = []
): Packet[] {
  let bitMask = !!lastBitMask ? column.getMask() ^ (column.getMask() & ((lastBitMask << 1) - 1)) : column.getMask();
  let bitMap = lastBitMask ?? 0b0;
  let newChunkData = new SmartBuffer();

  // blockEntities
  // chunkEntities.push(...Object.values(column.blockEntities as Map<string, ChunkEntity>));

  // checks with bitmask if there is a chunk in memory that (a) exists and (b) was not sent to the client yet
  for (let i = 0; i < 16; i++)
    if (bitMask & (0b1 << i)) {
      column.sections[i].write(newChunkData);
      bitMask ^= 0b1 << i;
      if (chunkData.length + newChunkData.length > MAX_CHUNK_DATA_LENGTH) {
        if (!lastBitMask) column.biomes?.forEach((biome: number) => chunkData.writeUInt8(biome));
        return [
          ['map_chunk', { x, z, bitMap, chunkData: chunkData.toBuffer(), groundUp: !lastBitMask, blockEntities: [] }],
          ...chunkColumnToPackets(bot, { chunkX: x, chunkZ: z, column }, 0b1 << i, newChunkData),
          ...getChunkEntityPackets(bot, column.blockEntities),
        ];
      }
      bitMap ^= 0b1 << i;
      chunkData.writeBuffer(newChunkData.toBuffer());
      newChunkData.clear();
    }
  if (!lastBitMask) column.biomes?.forEach((biome: number) => chunkData.writeUInt8(biome));
  return [['map_chunk', { x, z, bitMap, chunkData: chunkData.toBuffer(), groundUp: !lastBitMask, blockEntities: [] }], ...getChunkEntityPackets(bot, column.blockEntities)];
}

function getChunkEntityPackets(bot: Bot, blockEntities: { [pos: string]: ChunkEntity }) {
  const packets: Packet[] = [];
  for (const nbtData of Object.values(blockEntities)) {
    const location = new Vec3(nbtData.value.x.value, nbtData.value.y.value, nbtData.value.z.value)
    const block = bot.blockAt(location);
    if (block?.type === 138) { // Beacon
      packets.push(['tile_entity_data', { location, nbtData, action: 3 }]);
    } else if (block?.type === 144) { // Skull
      packets.push(['tile_entity_data', { location, nbtData, action: 4 }]);
    } else if (block?.type === 140) { // Flower pot
      packets.push(['tile_entity_data', { location, nbtData, action: 5 }]);
    } else if (block?.type === 176 || block?.type === 177) { // Wall and standing banner
      packets.push(['tile_entity_data', { location, nbtData, action: 6 }]);
    } else if (block?.type === 209) { // End gateway
      packets.push(['tile_entity_data', { location, nbtData, action: 8 }]);
    } else if (block?.type === 63 || block?.type === 68) { // Sign
      packets.push(['tile_entity_data', { location, nbtData, action: 9 }]);
    } else if (block?.type === 26) { // Bed
      packets.push(['tile_entity_data', { location, nbtData, action: 11 }]);
    } else {
      packets.push(['tile_entity_data', { location, nbtData }])
    }
    if (block?.name == 'minecraft:chest') {
      packets.push(['block_action', { location, byte1: 1, byte2: 0, blockId: block.type }]);
    }
  }
  return packets;
}

function posInChunk (pos: Vec3) {
  return new Vec3(Math.floor(pos.x) & 15, Math.floor(pos.y), Math.floor(pos.z) & 15)
}

function clonePositionValueNbt(input: NbtPositionTag) {
  const clone: NbtPositionTag = {
    type: 'int',
    value: Number(input.value)
  }
  return clone
}
