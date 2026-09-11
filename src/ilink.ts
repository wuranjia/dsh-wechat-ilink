import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import qrcode from "qrcode-terminal";
import { WeChatBot } from "@wechatbot/wechatbot";

export interface IlinkBotOptions {
  storageDir: string;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
}

/** Create the iLink bot with QR rendering wired to the terminal and a state file. */
export function createIlinkBot(options: IlinkBotOptions): WeChatBot {
  return new WeChatBot({
    storage: "file",
    storageDir: options.storageDir,
    logLevel: options.logLevel,
    loginCallbacks: {
      onQrUrl: (url) => {
        void presentQrCode(url, options.storageDir);
      },
      onScanned: () => {
        console.error("[wechat-ilink] QR code scanned; awaiting confirmation…");
      },
      onExpired: () => {
        console.error("[wechat-ilink] QR code expired; requesting a new one…");
      },
    },
  });
}

async function presentQrCode(url: string, storageDir: string): Promise<void> {
  console.error("[wechat-ilink] Scan this QR code with WeChat to log in:");
  qrcode.generate(url, { small: true }, (code) => console.error(code));
  console.error(`[wechat-ilink] QR URL: ${url}`);
  try {
    await mkdir(storageDir, { recursive: true });
    await writeFile(join(storageDir, "login-qr.txt"), `${url}\n`, "utf8");
  } catch {
    // The terminal QR is the primary surface; the file is best effort.
  }
}
