import sharp from "sharp";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import fs from "fs";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function getText(message) {
    const content = getMessageContent(message);
    return content?.conversation || content?.extendedTextMessage?.text || content?.imageMessage?.caption || content?.videoMessage?.caption || "";
}

function getMessageContent(message) {
    const messageContent = message?.message || message;
    return messageContent?.ephemeralMessage?.message
        || messageContent?.viewOnceMessage?.message
        || messageContent?.viewOnceMessageV2?.message
        || messageContent;
}

function numberFromJid(jid) {
    return String(jid || "").split("@")[0].split(":")[0];
}

function logJid(jid, config, botJid) {
    const value = String(jid || "");
    const number = numberFromJid(value);
    const botNumber = numberFromJid(botJid);
    if (value.endsWith("@lid") && number === botNumber) {
        return `${normalizeNumber(config.pairingNumber || config.ownerNumber)}@s.whatsapp.net`;
    }
    return value || "-";
}

const PROFILE_FILE = new URL("./profiles.json", import.meta.url);
const profiles = fs.existsSync(PROFILE_FILE)
    ? JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"))
    : {};
const OWNER_FILE = new URL("./owners.json", import.meta.url);
const additionalOwners = fs.existsSync(OWNER_FILE)
    ? JSON.parse(fs.readFileSync(OWNER_FILE, "utf8")).map((owner) => typeof owner === "string"
        ? { number: normalizeNumber(owner), name: "Owner" }
        : { number: normalizeNumber(owner.number || owner.nomor || ""), name: owner.name || owner.nama || "Owner" })
    : [];
const MODE_FILE = new URL("./bot-mode.json", import.meta.url);
const modeData = fs.existsSync(MODE_FILE)
    ? JSON.parse(fs.readFileSync(MODE_FILE, "utf8"))
    : { mode: "public" };
let botMode = modeData.mode === "self" ? "self" : "public";
const EXP_PER_LEVEL = 10000;

function saveProfiles() {
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profiles, null, 2));
}

function saveOwners() {
    fs.writeFileSync(OWNER_FILE, JSON.stringify(additionalOwners, null, 2));
}

function saveBotMode() {
    fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: botMode }, null, 2));
}

function getOwnerEntries() {
    return additionalOwners
        .filter((owner) => owner && owner.number)
        .map((owner) => ({
            number: normalizeNumber(owner.number),
            name: owner.name || owner.nama || "Owner"
        }));
}

function normalizeNumber(number) {
    const digits = String(number || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.startsWith("62")) return digits;
    if (digits.startsWith("0")) return `62${digits.slice(1)}`;
    return digits;
}

function normalizeJid(jid) {
    return normalizeNumber(numberFromJid(jid));
}

function isPrimaryOwner(config, jid) {
    return normalizeJid(jid) === normalizeJid(config.ownerNumber);
}

function isConfiguredOwner(config, jid) {
    const normalized = normalizeJid(jid);
    const ownerNumbers = getOwnerEntries().map((owner) => owner.number);
    return isPrimaryOwner(config, jid) || ownerNumbers.includes(normalized);
}

function canUseBot(config, sender) {
    if (botMode !== "self") return true;
    return isConfiguredOwner(config, sender);
}

function getProfile(jid) {
    if (!profiles[jid]) profiles[jid] = { exp: 0 };
    return profiles[jid];
}

function getLevel(exp) {
    return Math.floor(exp / EXP_PER_LEVEL) + 1;
}

function getRank(level) {
    if (level >= 100) return "🐉 Mythic";
    if (level >= 80) return "⚔️ Legend";
    if (level >= 60) return "💜 Epic";
    if (level >= 40) return "💪 Grandmaster";
    if (level >= 20) return "🎖️ Master";
    if (level >= 10) return "⭐ Elite";
    return "🛡️ Warrior";
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function getGpuName() {
    try {
        if (process.platform === "win32") {
            const { stdout } = await execFileAsync(
                "powershell.exe",
                ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ', '"],
                { timeout: 3000, windowsHide: true }
            );
            return stdout.trim() || "Tidak terdeteksi";
        }

        if (process.platform === "linux") {
            const { stdout } = await execFileAsync("lspci", [], { timeout: 3000 });
            const gpuNames = stdout.split("\n")
                .map((line) => line.match(/(?:VGA compatible controller|3D controller|Display controller):\s*(.+)$/i)?.[1]?.trim())
                .filter(Boolean);
            return gpuNames.join(", ") || "Tidak terdeteksi";
        }

        if (process.platform === "darwin") {
            const { stdout } = await execFileAsync(
                "system_profiler",
                ["SPDisplaysDataType", "-detailLevel", "mini"],
                { timeout: 3000 }
            );
            const gpuNames = stdout.split("\n")
                .filter((line) => /chipset model:/i.test(line))
                .map((line) => line.split(":").slice(1).join(":").trim());
            return gpuNames.join(", ") || "Tidak terdeteksi";
        }
    } catch {
        return "Tidak terdeteksi";
    }
    return "Tidak terdeteksi";
}

async function getDeviceInfo() {
    const memory = process.memoryUsage();
    const cpus = os.cpus();
    return {
        os: `${os.type()} ${os.release()}`,
        arch: process.arch,
        cpu: cpus[0]?.model || "Tidak terdeteksi",
        cores: cpus.length,
        ram: `${formatBytes(os.totalmem() - os.freemem())} / ${formatBytes(os.totalmem())}`,
        processRam: formatBytes(memory.rss),
        node: process.version,
        gpu: await getGpuName()
    };
}

function chatLog(config, direction, jid, text, botJid) {
    if (config.debug) {
        console.log(`[CHAT ${new Date().toLocaleTimeString("id-ID")}] ${direction} ${logJid(jid, config, botJid)}: ${text}`);
    }
}

function mainMenu(config, prefix, uptime, sender, pushName) {
    const time = new Date().toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit"
    });
    const name = pushName || "User";
    const profile = getProfile(sender);
    const level = getLevel(profile.exp || 0);
    const rawRole = isConfiguredOwner(config, sender) ? "Owner" : "User";
    const role = rawRole === "Owner" ? "👑 Owner" : "🧑 User";
    const rank = getRank(level);
    const botName = config.botName || "Asisten Ferdi";

    return `⚡ *Keep up the great work!*

Hello, my friend *"${name}"*!
How are you today? You're feeling well, right?

        ᯓ INFO USER

╭   • Nama  : ${pushName || "User"}
┆   • ID    : ${numberFromJid(sender)}
┆   • Waktu : ${time} WIB
┆   • Role  : ${role}
┆   • Rank  : ${rank}
┆   • Level : ${level}
┆   • Exp   : ${(profile.exp || 0).toLocaleString("id-ID")}
╰➤------------------------------

    ᯓ INFO BOT
╭  • Name : ${botName}
┆  • Author : ${config.ownerName}
┆  • Mode : ${botMode === "self" ? "Self (Private)" : "Public"}
┆   • Rank : ${rank}
┆   • Level : ${level}
┆  • Uptime : *${uptime()}*
╰➤------------------------------

Hey *${name}*, aku *${botName}*
Silakan pilih menu di bawah.

 ✦ DAFTAR MENU ✦
╭   • ${prefix}generalmenu 🏠
┆   • ${prefix}stickermenu 🖼️
┆   • ${prefix}ownermenu 👑
╰➤------------------------------`;
}

function stickerMenu(prefix) {
    return `╭─〔 🖼️ STICKER MENU〕─⬣
│ ✦ *${prefix}s* - Gambar jadi sticker
│ ✦ *${prefix}bratimg <teks>* - Brat sticker
│ ✦ *${prefix}ttp <teks>* - Text to picture
╰─⬣`;
}

function ownerMenu(prefix) {
    return `╭─〔 👑 OWNER MENU〕─⬣
│ ✦ *${prefix}addexp <jumlah>*
│ ✦ *${prefix}addlevel <jumlah>*
│ ✦ *${prefix}delexp <jumlah>*
│ ✦ *${prefix}dellevel <jumlah>*
│ ✦ *${prefix}addowner <ID>*
│ ✦ *${prefix}deleteowner <ID>*
│ ✦ *${prefix}ownerlist* - Daftar owner aktif
│ ✦ *${prefix}self* - Hanya owner 
│ ✦ *${prefix}public* - Semua orang
╰─⬣`;
}

function getActiveOwners(config) {
    const owners = [
        { number: normalizeNumber(config.ownerNumber), name: config.ownerName || "Owner" },
        ...getOwnerEntries()
    ];
    return owners.filter((owner, index, array) => {
        const duplicateIndex = array.findIndex((item) => item.number === owner.number);
        return duplicateIndex === index && owner.number;
    });
}

function modeStatusMessage(mode) {
    if (mode === "self") {
        return `╭─〔 🔒 SELF MODE 〕─⬣
│ Status : Aktif
│ Akses  : Hanya owner
│ Info   : Bot hanya bisa dipakai owner.
╰─⬣`;
    }

    return `╭─〔 🌐 PUBLIC MODE 〕─⬣
│ Status : Aktif
│ Akses  : Semua user
│ Info   : Bot bisa dipakai semua orang.
╰─⬣`;
}

function allMenu(prefix) {
    return `╭─〔 📚 ALL MENU 〕─⬣
│
│ 🏠 *GENERAL*
│ ✦ ${prefix}lihat1x - Lihat pesan sekali lihat
│ ✦ ${prefix}ping - Cek respon bot
│ ✦ ${prefix}owner - Info owner
│ ✦ ${prefix}stats - Profil dan level lengkap
│
│ 🖼️ *STICKER & TOOLS*
│ ✦ ${prefix}s - Gambar jadi sticker
│ ✦ ${prefix}bratimg <teks> - Brat sticker
│ ✦ ${prefix}ttp <teks> - Text to picture sticker
│ ✦ ${prefix}gpt <pertanyaan> - Tanya AI
│
│ 👑 *OWNER ONLY*
│ ✦ ${prefix}addexp <jumlah> - Tambah EXP
│ ✦ ${prefix}addlevel <jumlah> - Tambah level
│ ✦ ${prefix}delexp <jumlah> - Kurangi EXP
│ ✦ ${prefix}dellevel <jumlah> - Kurangi level
│ ✦ ${prefix}addowner <ID> - Tambah owner
│ ✦ ${prefix}deleteowner <ID> - Hapus owner
│ ✦ ${prefix}self - Aktifkan mode owner-only
│ ✦ ${prefix}public - Aktifkan mode publik
╰─⬣`;
}

async function sendImageAsSticker(sock, chat, message, imageBuffer) {
    const sticker = await sharp(imageBuffer)
        .resize(512, 512, { fit: "inside", withoutEnlargement: true })
        .webp()
        .toBuffer();
    return sock.sendMessage(chat, { sticker }, { quoted: message });
}

async function createBratSticker(sock, chat, message, text) {
    const response = await fetch(`https://api.nexray.eu.cc/maker/brat?text=${encodeURIComponent(text)}`);
    if (!response.ok) throw new Error(`Brat API ${response.status}`);
    await sendImageAsSticker(sock, chat, message, Buffer.from(await response.arrayBuffer()));
}

async function createTtpSticker(sock, chat, message, text) {
    const response = await fetch(`https://api.nexray.eu.cc/maker/ttp?text=${encodeURIComponent(text)}`);
    if (!response.ok) throw new Error(`TTP API ${response.status}`);
    await sendImageAsSticker(sock, chat, message, Buffer.from(await response.arrayBuffer()));
}

async function askGpt(config, prompt) {
    const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY belum diatur oleh owner.");

    const model = config.geminiModel || "gemini-3.6-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            contents: [{
                role: "user",
                parts: [{
                    text: `Kamu adalah asisten AI yang santai, cerdas, dan membantu. Jawab dalam bahasa Indonesia dengan ringkas, jelas, dan sopan.\n\nPertanyaan pengguna:\n${prompt}`
                }]
            }],
            generationConfig: { temperature: 0.7 }
        })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Gemini API error ${response.status}`);
    return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim()
        || "AI tidak mengirim jawaban.";
}

async function createMediaSticker(sock, chat, message) {
    if (!message.message?.imageMessage) return false;
    const image = await downloadMediaMessage(message, "buffer", {}, { logger: console });
    await sendImageAsSticker(sock, chat, message, image);
    return true;
}

async function readViewOnce(sock, chat, message) {
    const quotedMessage = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quotedMessage) {
        throw new Error(`Reply pesan sekali lihat dengan caption .lihat1x`);
    }

    const content = getMessageContent(quotedMessage);
    const text = getText(quotedMessage);
    if (text) {
        return sock.sendMessage(chat, { text: `👁️ *Pesan sekali lihat:*

${text}` }, { quoted: message });
    }

    const mediaType = ["imageMessage", "videoMessage", "audioMessage", "documentMessage"]
        .find((type) => content?.[type]);
    if (!mediaType) {
        throw new Error("Format pesan sekali lihat tidak didukung");
    }

    const quoted = {
        key: {
            remoteJid: chat,
            fromMe: false,
            id: message.message.extendedTextMessage.contextInfo.stanzaId || "VIEW_ONCE",
            participant: message.message.extendedTextMessage.contextInfo.participant || chat
        },
        message: quotedMessage
    };
    const buffer = await downloadMediaMessage(quoted, "buffer", {}, { logger: console });
    const media = content[mediaType];
    const payload = { [mediaType.replace("Message", "")]: buffer };
    if (media.caption) payload.caption = media.caption;
    if (media.mimetype) payload.mimetype = media.mimetype;
    return sock.sendMessage(chat, payload, { quoted: message });
}

async function sendMainMenu(sock, chat, message, config, text) {
    const image = fs.readFileSync(new URL("./assets/killua.png", import.meta.url));
    return sock.sendMessage(chat, {
        text,
        contextInfo: {
            isForwarded: true,
            forwardingScore: 9,
            externalAdReply: {
                title: config.botName || "Asisten Ferdi",
                body: "BOT WHATSAPP MULTI DEVICE",
                sourceUrl: "https://ferdiansyah.vercel.app",
                mediaType: 1,
                renderLargerThumbnail: true,
                thumbnail: image
            }
        }
    }, { quoted: message });
}

export { getText };

export async function handleMessage({
    sock,
    message,
    config,
    prefix,
    chats,
    isOwner,
    uptime,
    counters
}) {
    const chat = message.key.remoteJid;
    const sender = message.key.participant || chat;
    const botNumber = numberFromJid(sock.user?.id);
    const isSelfChat = message.key.fromMe && chat && numberFromJid(chat) === botNumber;
    if (config.debug) {
        console.log(`[DEBUG ${new Date().toLocaleTimeString("id-ID")}] Pesan detail: chat=${logJid(chat, config, sock.user?.id)}, fromMe=${Boolean(message.key.fromMe)}, selfChat=${Boolean(isSelfChat)}, tipe=${Object.keys(message.message || {}).join(",") || "kosong"}`);
    }
    if (!message.message) return;

    const text = getText(message).trim();
    if (!chat || !text) return;
    chats.add(chat);
    counters.messageCount += 1;
    chatLog(config, "IN", sender, text, sock.user?.id);
    if (!text.startsWith(prefix)) return;

    const args = text.slice(prefix.length).trim().split(/ +/);
    const command = args.shift()?.toLowerCase();
    counters.commandCount += 1;
    if (!canUseBot(config, sender)) {
        await sock.sendMessage(chat, {
            text: "🔒 Bot sedang dalam mode self. Hanya owner yang bisa menggunakan bot."
        }, { quoted: message });
        return;
    }
    const profile = getProfile(sender);
    profile.exp += 10;
    saveProfiles();
    if (config.debug) {
        console.log(`[DEBUG ${new Date().toLocaleTimeString("id-ID")}] Menjalankan command: ${prefix}${command} dari ${logJid(sender, config, sock.user?.id)}`);
    }
    try {
        await handleCommand({
            sock,
            message,
            chat,
            sender,
            command,
            args,
            config,
            prefix,
            chats,
            isOwner: (jid) => isOwner(jid) || Boolean(message.key.fromMe),
            uptime,
            messageCount: counters.messageCount,
            commandCount: counters.commandCount
        });
    } catch (error) {
        console.error(`[ERROR] Command ${prefix}${command} gagal:`, error);
    }
}

export async function handleCommand({
    sock,
    message,
    chat,
    sender,
    command,
    args,
    config,
    prefix,
    chats,
    isOwner,
    uptime,
    messageCount,
    commandCount
}) {
    const reply = async (content) => {
        if (config.debug) {
            console.log(`[CHAT ${new Date().toLocaleTimeString("id-ID")}] OUT ${chat.split("@")[0]}: ${content}`);
        }
        return sock.sendMessage(chat, { text: content }, { quoted: message });
    };
    const primaryOwner = isPrimaryOwner(config, sender);
    const ownerAccess = primaryOwner || getOwnerEntries().some((owner) => owner.number === normalizeJid(sender)) || isOwner(sender);

    if (command === "menu" || command === "help") {
        await sendMainMenu(sock, chat, message, config, mainMenu(config, prefix, uptime, sender, message.pushName));
    } else if (command === "stickermenu" || command === "stikermenu") {
        await reply(stickerMenu(prefix));
    } else if (command === "bratimg") {
        if (!args.length) await reply(`Format: ${prefix}bratimg <teks>`);
        else {
            try {
                await createBratSticker(sock, chat, message, args.join(" "));
            } catch (error) {
                console.error("Brat sticker gagal:", error.message);
                await reply("Gagal membuat brat sticker. Coba lagi nanti.");
            }
        }
    } else if (command === "s") {
        try {
            const created = await createMediaSticker(sock, chat, message);
            if (!created) await reply(`Kirim atau reply gambar dengan caption ${prefix}s.`);
        } catch (error) {
            console.error("Sticker gambar gagal:", error.message);
            await reply("Gagal membuat sticker dari gambar.");
        }
    } else if (command === "ttp") {
        if (!args.length) await reply(`Format: ${prefix}ttp <teks>`);
        else {
            try {
                await createTtpSticker(sock, chat, message, args.join(" "));
            } catch (error) {
                console.error("TTP sticker gagal:", error.message);
                await reply("Gagal membuat TTP sticker. Coba lagi nanti.");
            }
        }
    } else if (command === "gpt" || command === "ai") {
        if (!args.length) await reply(`Format: ${prefix}gpt <pertanyaan>`);
        else {
            const thinkingMessage = await reply("🤖 AI sedang berpikir...");
            try {
                const answer = await askGpt(config, args.join(" "));
                await sock.sendMessage(chat, {
                    text: answer,
                    edit: thinkingMessage.key
                });
            } catch (error) {
                await sock.sendMessage(chat, {
                    text: `❌ Gagal menghubungi AI: ${error.message}`,
                    edit: thinkingMessage.key
                });
            }
        }
    } else if (command === "generalmenu") {
        await reply(`╭─〔 🏠 GENERAL 〕─⬣\n│ ${prefix}menu\n│ ${prefix}ping\n│ ${prefix}owner\n│ ${prefix}lihat1x - Lihat pesan sekali lihat\n╰─⬣`);
    } else if (command === "allmenu") {
        await reply(allMenu(prefix));
    } else if (command === "lihat1x") {
        try {
            await readViewOnce(sock, chat, message);
        } catch (error) {
            await reply(`❌ ${error.message}`);
        }
    } else if (command === "self" || command === "public") {
        if (!ownerAccess) await reply("🔒 Command ini khusus owner.");
        else {
            botMode = command;
            saveBotMode();
            await reply(modeStatusMessage(command));
        }
    } else if (command === "addowner") {
        if (!ownerAccess) await reply("🔒 Command ini khusus owner.");
        else if (!args[0]) await reply(`Format: ${prefix}addowner <ID> [nama]`);
        else {
            const rawNumber = args[0];
            const ownerName = args.slice(1).join(" ") || "Owner";
            const newOwner = normalizeNumber(rawNumber);
            if (!newOwner) await reply("❌ ID owner tidak valid.");
            else if (isPrimaryOwner(config, newOwner) || getOwnerEntries().some((owner) => owner.number === newOwner)) {
                await reply("⚠️ ID tersebut sudah terdaftar sebagai owner.");
            } else {
                additionalOwners.push({ number: newOwner, name: ownerName });
                saveOwners();
                await reply(`✅ ${newOwner} (${ownerName}) berhasil ditambahkan sebagai owner.`);
            }
        }
    } else if (command === "deleteowner") {
        if (!ownerAccess) await reply("🔒 Command ini khusus owner.");
        else if (!args[0]) await reply(`Format: ${prefix}deleteowner <ID>`);
        else {
            const targetOwner = normalizeNumber(args[0]);
            if (isPrimaryOwner(config, targetOwner)) {
                await reply("❌ Owner utama tidak bisa dihapus.");
            } else {
                const ownerIndex = additionalOwners.findIndex((owner) => normalizeNumber(owner.number || owner.nomor || owner) === targetOwner);
                if (ownerIndex === -1) await reply("❌ ID tersebut bukan owner tambahan.");
                else {
                    additionalOwners.splice(ownerIndex, 1);
                    saveOwners();
                    await reply(`✅ ${targetOwner} berhasil dihapus dari owner.`);
                }
            }
        }
    } else if (command === "ownermenu") {
        if (!ownerAccess) await reply("🔒 Menu ini hanya untuk owner.");
        else await reply(ownerMenu(prefix));
    } else if (command === "ownerlist") {
        if (!ownerAccess) await reply("🔒 Command ini khusus owner.");
        else {
            const owners = getActiveOwners(config);
            const list = owners.length
                ? owners.map((owner, index) => `│ ${index + 1}. ${owner.name} - ${owner.number}`).join("\n")
                : "│ Tidak ada owner aktif.";
            await reply(`╭─〔 👑 OWNER LIST 〕─⬣\n${list}\n╰─⬣`);
        }
    } else if (command === "ping") {
        const pingStarted = Date.now();
        const device = await getDeviceInfo();
        const latency = Date.now() - pingStarted;
        await reply(`╭─〔 ⚡ PING & DEVICE 〕─⬣
│ Bot    : ${config.botName}
│ Status : Online
│ Respon : ${latency} ms
│ Uptime : ${uptime()}
│
│ 💻 OS   : ${device.os}
│ 🧩 Arch : ${device.arch}
│ ⚙️ CPU  : ${device.cpu}
│ 🔢 Core : ${device.cores}
│ 🧠 RAM  : ${device.ram}
│ 📦 App  : ${device.processRam}
│ 🎮 GPU  : ${device.gpu}
│ 🟢 Node : ${device.node}
╰─⬣`);
    } else if (command === "owner") {
        const ownerNumber = normalizeNumber(config.ownerNumber);
        const owners = getActiveOwners(config);
        const ownerList = owners.length
            ? owners.map((owner, index) => `${index + 1}. ${owner.name} - ${owner.number}`).join("\n")
            : "1. Tidak ada owner aktif";
        await reply(`╭─〔 ⚡ OWNER CONTACT 〕─⬣
│
│ 👑 *${config.ownerName}*
│
│ Yo, kalau ada masalah atau
│ butuh bantuan soal bot, hubungi
│ owner lewat kontak di bawah.
│
│ 📞 Nomor : ${ownerNumber}
│ 🤖 Bot   : ${config.botName}
│ 🌐 Web   : https://ferdiansyah.vercel.app
│ 🔗 Chat  : https://wa.me/${ownerNumber}
│
│
│ Jangan spam. Sampaikan dengan jelas,
│ nanti dibantu kalau memang perlu.
╰─⬣`);
    } else if (command === "stats") {
        const profile = getProfile(sender);
        const level = getLevel(profile.exp);
        await reply(`╭─〔 ⭐ PROFILE 〕─⬣
│ Nama: ${message.pushName || "User"}
│ EXP: ${profile.exp.toLocaleString("id-ID")}
│ Level: ${level}
│ Rank: ${getRank(level)}
│ EXP berikutnya: ${(level * EXP_PER_LEVEL - profile.exp).toLocaleString("id-ID")}
╰─⬣`);
    } else if (["addexp", "addlevel", "delexp", "dellevel"].includes(command)) {
        if (!ownerAccess) await reply("🔒 Command ini khusus owner.");
        else {
            const amount = Math.max(0, Number.parseInt(args[0], 10) || 0);
            const profile = getProfile(sender);
            const change = command.endsWith("level") ? amount * EXP_PER_LEVEL : amount;
            profile.exp = command.startsWith("del")
                ? Math.max(0, profile.exp - change)
                : profile.exp + change;
            saveProfiles();
            await reply(`✅ ${command} berhasil.
EXP: ${profile.exp.toLocaleString("id-ID")}
Level: ${getLevel(profile.exp)}
Rank: ${getRank(getLevel(profile.exp))}`);
        }
    }
}