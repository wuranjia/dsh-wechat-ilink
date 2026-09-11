import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import qrcode from "qrcode-terminal";
import { WeChatBot, type QrLoginCallbacks } from "@wechatbot/wechatbot";

export interface IlinkBotOptions {
  storageDir: string;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
}

/** Create the iLink bot with QR rendering wired to the terminal and a state file. */
export function createIlinkBot(options: IlinkBotOptions): WeChatBot {
  const loginCallbacks: QrLoginCallbacks = {
    onQrUrl: (url: string) => {
      void presentQrCode(url, options.storageDir);
    },
    onScanned: () => {
      console.error("[wechat-ilink] QR code scanned; awaiting confirmation…");
    },
    onExpired: () => {
      console.error("[wechat-ilink] QR code expired; requesting a new one…");
    },
  };
  const bot = new WeChatBot({
    storage: "file",
    storageDir: options.storageDir,
    logLevel: options.logLevel,
  });
  // The SDK drops constructor loginCallbacks at runtime (type-only), and its
  // internal re-login calls login({force:true}) with no callbacks — inject on
  // every call so QR rendering survives both paths.
  const originalLogin = bot.login.bind(bot);
  bot.login = (loginOptions?: { force?: boolean; callbacks?: QrLoginCallbacks }) =>
    originalLogin({ ...loginOptions, callbacks: { ...loginCallbacks, ...loginOptions?.callbacks } });
  return bot;
}

async function presentQrCode(url: string, storageDir: string): Promise<void> {
  try {
    console.error("[wechat-ilink] Scan this QR code with WeChat to log in:");
    qrcode.generate(url, { small: true }, (code) => console.error(code));
    console.error(`[wechat-ilink] QR URL: ${url}`);
    await mkdir(storageDir, { recursive: true });
    await writeFile(join(storageDir, "login-qr.txt"), `${url}\n`, "utf8");
  } catch (error) {
    console.error(`[wechat-ilink] QR presentation failed: ${String(error)}`);
  }
}
