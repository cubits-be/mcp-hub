import dgram from "node:dgram";
import type { CustomTool } from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WOL_MAC = process.env.WOL_MAC;
const WOL_NAME = process.env.WOL_NAME ?? "pc";
const WOL_BROADCAST = process.env.WOL_BROADCAST ?? "255.255.255.255";
const WOL_PORT = Number(process.env.WOL_PORT ?? "9");
const PACKET_COUNT = 3;

// ---------------------------------------------------------------------------
// Magic packet
// ---------------------------------------------------------------------------

/** Magic packet = 6 x 0xFF followed by the target MAC repeated 16 times. */
function buildMagicPacket(mac: string): Buffer {
  const hex = mac.replace(/[:-]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) throw new Error(`Invalid WOL_MAC: "${mac}"`);
  const macBytes = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array<Buffer>(16).fill(macBytes)]);
}

function sendBroadcast(packet: Buffer, address: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      let remaining = PACKET_COUNT;
      const sendNext = () => {
        socket.send(packet, port, address, (err) => {
          if (err) {
            socket.close();
            return reject(err);
          }
          if (--remaining > 0) return setTimeout(sendNext, 100);
          socket.close();
          resolve();
        });
      };
      sendNext();
    });
  });
}

// ---------------------------------------------------------------------------
// Tool: wake
// ---------------------------------------------------------------------------

const wakeTool: CustomTool = {
  definition: {
    name: "wol__wake",
    description:
      `Sends a Wake-on-LAN magic packet to power on the configured PC ("${WOL_NAME}"). ` +
      "Fire-and-forget: the packet is sent over UDP broadcast and there is no confirmation that the PC actually booted. " +
      "Only works if the PC is wired, has WoL enabled in BIOS/OS, and is on the same LAN as the hub.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    if (!WOL_MAC) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "Wake-on-LAN is not configured: set WOL_MAC in the hub's environment." }],
      };
    }
    try {
      await sendBroadcast(buildMagicPacket(WOL_MAC), WOL_BROADCAST, WOL_PORT);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Failed to send magic packet: ${(err as Error).message}` }],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Sent ${PACKET_COUNT} magic packets for ${WOL_NAME} (${WOL_MAC}) to ${WOL_BROADCAST}:${WOL_PORT}. ` +
            "The PC should start booting within a few seconds if WoL is set up correctly.",
        },
      ],
    };
  },
};

export const wolTools: CustomTool[] = [wakeTool];
