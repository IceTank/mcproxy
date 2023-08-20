import type { Bot } from 'mineflayer';
import { Client } from './conn';

export class StateData {
  flying: boolean = false;
  bot: Bot;
  rawLoginPacket: any;
  rawCommandPacket: any;
  rawTags: any = [];
  rawRecipes: any[] | null = null;
  rawUnlockRecipes: any | null = null;

  constructor(bot: Bot) {
    this.bot = bot;

    this.bot._client.on('login', (packet) => this.rawLoginPacket = packet)
    this.bot._client.on('declare_commands', (packet) => this.rawCommandPacket = packet)
    this.bot._client.on('tags', (packet) => this.rawTags = packet)
    this.bot._client.on('unlock_recipes', (packet) => this.rawUnlockRecipes = packet)
    this.bot._client.on('declare_recipes', (packet) => this.rawRecipes = packet)
  }

  onCToSPacket(name: string, data: any, pclient: Client) {
    if (pclient.version !== '1.12.2' && pclient.positionPacketsSend === 0 && (name === 'position' || name === 'position_look')) {
      pclient.positionPacketsSend++;
      return;
    }
    if (name === 'login') {
      pclient.positionPacketsSend = 0; // @todo: find out if this is what vanilla does
    }
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
