import { PacketMeta } from "minecraft-protocol";
import { Bot } from "mineflayer";
import { Vec3 } from 'vec3'
import { Packet } from "./conn";
import { chunkColumnToPacketsNew } from "./packets";

const Chunk = require('prismarine-chunk')('1.12.2')

interface CoordinatesXYZ {
  x: number
  y: number
  z: number
}

interface CoordinatesXZ {
  x: number
  z: number
}

abstract class ITransformer {
  offsetChunkVec: Vec3
  offsetVec: Vec3
  constructor(offset: Vec3) {
    this.offsetChunkVec = offset.scaled(1/16).floor()
    this.offsetVec = this.offsetChunkVec.scaled(16)
  }

  abstract offset(pos: Vec3): CoordinatesXYZ
  abstract offsetXYZ(x: number, y: number, z: number): CoordinatesXYZ
  abstract offsetChunk(x: number, z: number): CoordinatesXZ
  abstract offsetSound(x: number, y: number, z: number): CoordinatesXYZ
}

class Transformer implements ITransformer {
  offsetChunkVec: Vec3
  offsetVec: Vec3
  constructor(offset: Vec3) {
    this.offsetChunkVec = offset.scaled(1/16).floor()
    this.offsetVec = this.offsetChunkVec.scaled(16)
  }

  offset(pos: Vec3) {
    return {
      x: pos.x - this.offsetVec.x,
      y: pos.y - this.offsetVec.y,
      z: pos.z - this.offsetVec.z,
    }
  }

  offsetXYZ(x: number, y: number, z: number) {
    return {
      x: x - this.offsetVec.x,
      y: y - this.offsetVec.y,
      z: z - this.offsetVec.z,
    }
  }

  offsetChunk(x: number, z: number) {
    return {
      x: x - Math.floor(this.offsetVec.x / 16),
      z: z - Math.floor(this.offsetVec.z / 16)
    }
  }

  offsetSound(x: number, y: number, z: number) {
    return {
      x: ((x / 8) - this.offsetVec.x) * 8,
      y: ((y / 8) - this.offsetVec.y) * 8,
      z: ((z / 8) - this.offsetVec.z) * 8,
    }
  }
}

export abstract class IPositionTransformer {
  offset: Vec3
  sToC: ITransformer
  cToS: ITransformer
  constructor(offset: Vec3) {
    this.offset = offset.clone()
    this.offset.y = 0
    this.sToC = new Transformer(offset)
    this.cToS = new Transformer(offset.scaled(-1))
  }

  abstract onCToSPacket(name: string, data: any): any | false
  abstract onSToCPacket(name: string, data: any): Packet[] | false
}

export class SimplePositionTransformer implements IPositionTransformer {
  offset: Vec3
  sToC: Transformer
  cToS: Transformer
  bot: Bot

  constructor(offset: Vec3, bot: Bot) {
    this.offset = offset
    this.sToC = new Transformer(offset)
    this.cToS = new Transformer(offset.scaled(-1))
    this.bot = bot
  }

  onCToSPacket(name: string, data: any): any | false {
    if ('location' in data) {
      data.location = this.cToS.offset(data.location)
      return data
    }
    let transformed = data
    switch (name) {
      case 'vehicle_move':
      case 'use_entity':
      case 'position_look':
        const { x, y, z } = data
        transformed = {
          ...data,
          ...this.cToS.offsetXYZ(x, y, z)
        }
        break
      case 'position':
        const flags = data.flags
        let { x: dx, y: dy, z: dz } = this.cToS.offsetXYZ(data.x, data.y, data.z)
        if (!(flags & 0x01)) {
          transformed.x = dx
        }
        if (!(flags & 0x02)) {
          transformed.y = dy
        }
        if (!(flags & 0x04)) {
          transformed.z = dz
        }
    }

    return transformed
  }

  onSToCPacket(name: string, data: any): Packet[] | false {
    if ('location' in data) {
      const { x, y, z } = this.sToC.offset(data.location)
      const transformed = {
        ...data,
        location: {
          x, y, z
        }
      }
      return [[name, transformed]]
    }
    if (name === 'sound_effect' || name === 'named_sound_effect') {
      const transformed = {
        ...data,
        ...this.sToC.offsetSound(data.x, data.y, data.z)
      }
      return [[name, transformed]]
    }
    if (name === 'unload_chunk') {
      const { x, z } = this.sToC.offsetChunk(data.x, data.z)
      const transformed = {
        chunkX: x,
        chunkZ: z
      }
      return [[name, transformed]]
    }
    if (name === 'map_chunk') {
      const column = new Chunk({ minY: 0, worldHeight: 256 })
      const transformerOffset = { offsetBlock: this.sToC.offsetVec, offsetChunk: this.sToC.offsetChunkVec }
      column.load(data.chunkData, data.bitMap, data.skyLightSent, data.groundUp)
      if (data.biomes !== undefined) {
        column.loadBiomes(data.biomes)
      }
      if (data.skyLight !== undefined) {
        column.loadParsedLight(data.skyLight, data.blockLight, data.skyLightMask, data.blockLightMask, data.emptySkyLightMask, data.emptyBlockLightMask)
      }
      if (data.blockEntities !== undefined && data.blockEntities.length > 0) {
        for (const blockEntity of data.blockEntities) {
          const pos = new Vec3(blockEntity.value.x.value & 0xf, blockEntity.value.y.value, blockEntity.value.z.value & 0xf)
          column.setBlockEntity(pos, blockEntity)
        }
      }
      const packets = chunkColumnToPacketsNew({ chunkX: Number(data.x), chunkZ: Number(data.z), column }, undefined, undefined, undefined, transformerOffset)
      return packets
    }

    let transformed = data
    switch (name) {
      case 'explosion': // Idk I think explosion does something weird
        return false
      case 'spawn_entity_living':
      case 'spawn_entity_weather':
      case 'spawn_entity_experience_orb':
      case 'spawn_entity':
      case 'entity_teleport':
      case 'vehicle_move':
      case 'world_particles':
      case 'named_entity_spawn':
      case 'position':
        transformed = {
          ...data,
          ...this.sToC.offsetXYZ(data.x, data.y, data.z)
        }
        break
      case 'multi_block_change':
      case 'map_chunk':
        transformed = {
          ...data,
          ...this.sToC.offsetChunk(data.x, data.z)
        }
    }
    return [[name, transformed]]
  }
}