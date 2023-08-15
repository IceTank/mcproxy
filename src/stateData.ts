import type { Bot } from 'mineflayer';

export class StateData {
  recipes: number[] = [];
  flying: boolean = false;
  bot: Bot;
  rawLoginPacket: any;
  rawCommandPacket: any;

  constructor(bot: Bot) {
    this.bot = bot;

    this.bot._client.on('login', (packet) => {this.rawLoginPacket = packet})
    this.bot._client.on('declare_commands', (packet)=> {this.rawCommandPacket = packet})
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
