import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    useMultiFileAuthState
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";

let prefix = config.prefix;
let botMode = "public";
const START_TIME = Date.now();
const chats = new Set();
let reconnectTimer = null;
let socketStarting = false;
let messageCount = 0;
let commandCount = 0;
let messageHandler = null;
let reloadTimer = null;
let configReloadTimer = null;
let ownerReloadTimer = null;

const terminalColors = {
    reset: "\x1b[0m",
    gray: "\x1b[90m",
    cyan: "\x1b[36m",
    green: "\x1b[92m",
    yellow: "\x1b[93m",
    red: "\x1b[91m",
    blue: "\x1b[94m",
    magenta: "\x1b[95m",
    white: "\x1b[97m"
};

function terminalLog(level, label, detail = "") {
    const styles = {
        success: ["✔", "OK  ", terminalColors.green],
        error: ["✖", "ERR ", terminalColors.red],
        warn: ["⚠", "WARN", terminalColors.yellow],
        system: ["⚙", "SYS ", terminalColors.cyan],
        debug: ["🐛", "DBG ", terminalColors.gray],
        info: ["ℹ", "INFO", terminalColors.blue],
        wait: ["⟳", "WAIT", terminalColors.yellow]
    };
    const [icon, tag, color] = styles[level] || styles.info;
    const time = new Date().toLocaleTimeString("id-ID", { hour12: false });
    const suffix = detail ? ` ${terminalColors.white}${detail}` : "";
    console.log(`${color}${icon} ${tag}${terminalColors.reset} ${terminalColors.gray}[${time}]${terminalColors.reset} ${terminalColors.cyan}${label}${terminalColors.reset}${suffix}`);
}

function printStartupBanner() {
    console.log(`\n${terminalColors.cyan}╭────────────────────────────────────────────╮${terminalColors.reset}`);
    console.log(`${terminalColors.cyan}│${terminalColors.reset} ${terminalColors.magenta}⚡ ASISTEN FERDI WHATSAPP BOT${terminalColors.reset}`);
    console.log(`${terminalColors.cyan}│${terminalColors.reset} ${terminalColors.gray}Multi-device • Hot reload • Owner system${terminalColors.reset}`);
    console.log(`${terminalColors.cyan}╰────────────────────────────────────────────╯${terminalColors.reset}\n`);
}

function numberFromJid(jid) {
    return String(jid || "").split("@")[0].split(":")[0];
}

function logJid(jid) {
    const value = String(jid || "");
    if (value.endsWith("@lid") && numberFromJid(value) === numberFromJid(sockIdentity)) {
        return `${normalizeNumber(config.pairingNumber || config.ownerNumber)}@s.whatsapp.net`;
    }
    return value || "-";
}

let sockIdentity = "";

function normalizeNumber(number) {
    const digits = String(number || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.startsWith("62")) return digits;
    if (digits.startsWith("0")) return `62${digits.slice(1)}`;
    return digits;
}

function isOwner(jid) {
    return normalizeNumber(numberFromJid(jid)) === normalizeNumber(numberFromJid(config.ownerNumber));
}

function uptime() {
    const seconds = Math.floor((Date.now() - START_TIME) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}j ${minutes}m ${seconds % 60}d`;
}

function debugLog(message) {
    if (config.debug) terminalLog("debug", "debug", message);
}

async function reloadCommandHandler() {
    try {
        const module = await import(`./commands.js?update=${Date.now()}`);
        messageHandler = module.handleMessage;
        terminalLog("success", "reload", "Kode command berhasil dimuat ulang");
    } catch (error) {
        terminalLog("error", "reload", `Kode command gagal dimuat: ${error.message}`);
    }
}

async function reloadConfig() {
    try {
        const module = await import(`./config.js?update=${Date.now()}`);
        Object.assign(config, module.config);
        prefix = config.prefix;
        terminalLog("success", "reload", "Konfigurasi bot berhasil dimuat ulang");
    } catch (error) {
        terminalLog("error", "reload", `Konfigurasi gagal dimuat: ${error.message}`);
    }
}

function reloadBotMode() {
    try {
        const raw = fs.readFileSync(new URL("./bot-mode.json", import.meta.url), "utf8");
        const data = JSON.parse(raw);
        botMode = data.mode === "self" ? "self" : "public";
        terminalLog("success", "mode", `Mode bot dimuat ulang: ${botMode}`);
    } catch (error) {
        terminalLog("error", "mode", `Mode gagal dimuat: ${error.message}`);
    }
}

fs.watch(new URL("./commands.js", import.meta.url), () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadCommandHandler, 100);
});

fs.watch(new URL("./config.js", import.meta.url), () => {
    clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(reloadConfig, 100);
});

fs.watch(new URL("./owners.json", import.meta.url), () => {
    clearTimeout(ownerReloadTimer);
    ownerReloadTimer = setTimeout(reloadCommandHandler, 100);
});

fs.watch(new URL("./bot-mode.json", import.meta.url), () => {
    reloadBotMode();
});

async function startBot() {
    if (socketStarting) return;
    socketStarting = true;
    terminalLog("wait", "boot", "Memulai koneksi bot...");

    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: ["Asisten Ferdi", "Chrome", "1.0.0"],
        printQRInTerminal: false
    });
    socketStarting = false;

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (qr && !state.creds.registered) {
            terminalLog("info", "pairing", "Scan QR code di WhatsApp untuk menghubungkan bot");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            sockIdentity = sock.user?.id || "";
            terminalLog("success", "connected", `${config.botName} terhubung sebagai ${logJid(sockIdentity)}`);
            terminalLog("success", "system", "Koneksi WhatsApp terbuka");
        }
        if (connection === "close") {
            const statusCode = lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output.statusCode
                : lastDisconnect?.error?.statusCode;
            const errorMessage = lastDisconnect?.error?.message || "alasan tidak diketahui";
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;
            debugLog(`Koneksi tertutup. Status: ${statusCode || "-"}. Alasan: ${errorMessage}. Reconnect: ${shouldReconnect ? "ya" : "tidak"}.`);
            if (statusCode === 440) {
                terminalLog("error", "session", "Session konflik, tutup instance bot lain lalu jalankan kembali");
            }
            if (shouldReconnect && !reconnectTimer) {
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    debugLog("Mencoba reconnect...");
                    startBot();
                }, 3000);
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify" && type !== "append") return;
        terminalLog("info", "message", `Menerima ${messages.length} pesan (${type})`);
        for (const message of messages) {
            const counters = { messageCount, commandCount };
            await messageHandler({
                sock,
                message,
                config,
                prefix,
                chats,
                isOwner,
                uptime,
                counters
            });
            messageCount = counters.messageCount;
            commandCount = counters.commandCount;
        }
    });
}

process.once("SIGINT", () => {
    process.exit(0);
});

printStartupBanner();
await reloadCommandHandler();
startBot();
