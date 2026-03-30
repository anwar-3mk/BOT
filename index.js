// ============================================
// 🤖 بوت إدارة ديسكورد - نظام F1
// ============================================
// نظام متكامل لإدارة السيرفرات والمهام والخبرة والنقاط
// ============================================

const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const express = require('express');
require('dotenv').config();

// إنشاء تطبيق Express
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// ⚙️ متغيرات التكوين
// ============================================

// رمز البوت من ملف .env
const TOKEN = process.env.DISCORD_TOKEN;

// ============================================
// 🗄️ إعداد قاعدة البيانات SQLite
// ============================================

const db = new sqlite3.Database('./database.db');

// تهيئة جداول قاعدة البيانات الثلاث: المستخدمين، المهام، والجلسات الصوتية
db.serialize(() => {
  // جدول المستخدمين: يحفظ البيانات الأساسية والنقاط والخبرة
  db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    points INTEGER DEFAULT 0,
    xp INTEGER DEFAULT 0,
    voice_time INTEGER DEFAULT 0,
    last_message_time INTEGER DEFAULT 0,
    last_voice_time INTEGER DEFAULT 0
  )`);

  // جدول المهام اليومية: يحفظ المهام المعينة لكل مستخدم
  db.run(`CREATE TABLE IF NOT EXISTS daily_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    task TEXT,
    completed BOOLEAN DEFAULT 0,
    date TEXT
  )`);

  // جدول جلسات الصوت: يحفظ معلومات المشاركة الصوتية
  db.run(`CREATE TABLE IF NOT EXISTS voice_sessions (
    user_id TEXT,
    channel_id TEXT,
    join_time INTEGER,
    leave_time INTEGER
  )`);

  // جدول التحذيرات: يحفظ التحذيرات المعطاة للمستخدمين
  db.run(`CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    warned_by TEXT,
    reason TEXT,
    warned_at TEXT
  )`);
});

// ============================================
// 📱 إنشاء عميل ديسكورد
// ============================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ]
});

// ============================================
//   إعداد خادم HTTP لـ Render
// ============================================

app.get('/', (req, res) => {
  res.send('البوت يعمل بشكل طبيعي! ✅');
});

// بدء الخادم
app.listen(PORT, () => {
  console.log(`الخادم يعمل على المنفذ ${PORT}`);
});

// ============================================
//  🎤 متغيرات تتبع الصوت
// ============================================

// خريطة لتتبع جلسات الصوت النشطة
const voiceSessions = new Map();

// ============================================
// 🛠️ دوال مساعدة (Utility Functions)
// ============================================

/**
 * حساب مستوى المستخدم بناءً على نقاط الخبرة
 * @param {number} xp - نقاط الخبرة
 * @returns {number} مستوى المستخدم
 */
function getLevel(xp) {
  const levelThresholds = [100, 400, 800, 1700, 2800, 4100, 6000, 9000, 14000, 21500];
  for (let i = 0; i < levelThresholds.length; i++) {
    if (xp < levelThresholds[i]) {
      return i + 1;
    }
  }
  return levelThresholds.length + 1; // مستوى أعلى من 10
}

/**
 * حساب مستوى المشاركة الصوتية
 * @param {number} voiceTime - مدة الصوت بالدقائق
 * @returns {number} مستوى الصوت
 */
function getVoiceLevel(voiceTime) {
  return Math.floor(Math.sqrt(voiceTime / 60)) + 1;
}

/**
 * الحصول على ترتيب المستخدم
 * @param {string} userId - معرف المستخدم
 * @param {string} type - نوع الترتيب (xp أو points)
 * @returns {Promise<number>} ترتيب المستخدم
 */
function getUserRank(userId, type) {
  return new Promise((resolve, reject) => {
    let query = '';
    if (type === 'xp') {
      query = 'SELECT COUNT(*) as rank FROM users WHERE xp > (SELECT xp FROM users WHERE user_id = ?)';
    } else if (type === 'points') {
      query = 'SELECT COUNT(*) as rank FROM users WHERE points > (SELECT points FROM users WHERE user_id = ?)';
    }
    db.get(query, [userId], (err, row) => {
      if (err) reject(err);
      else resolve((row ? row.rank : 0) + 1);
    });
  });
}

/**
 * تحديث بيانات المستخدم
 * @param {string} userId - معرف المستخدم
 * @param {object} data - البيانات المراد تحديثها
 * @returns {Promise} نتيجة التحديث
 */
function updateUserData(userId, data) {
  return new Promise((resolve, reject) => {
    const fields = Object.keys(data).join(' = ?, ') + ' = ?';
    const values = Object.values(data);
    values.push(userId);

    db.run(`UPDATE users SET ${fields} WHERE user_id = ?`, values, function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

/**
 * إضافة مستخدم جديد إلى قاعدة البيانات
 * @param {string} userId - معرف المستخدم
 * @param {string} username - اسم المستخدم
 * @returns {Promise} نتيجة الإضافة
 */
function addUser(userId, username) {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)', [userId, username], function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
  });
}

/**
 * الحصول على بيانات المستخدم
 * @param {string} userId - معرف المستخدم
 * @returns {Promise<object>} بيانات المستخدم
 */
function getUserData(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

/**
 * الحصول على لوحة الصدارة
 * @param {string} type - نوع الترتيب
 * @param {string} period - الفترة الزمنية
 * @returns {Promise<array>} قائمة الأعضاء المرتبة
 */
function getLeaderboard(type, period) {
  return new Promise((resolve, reject) => {
    let query = '';
    let params = [];

    if (period === 'يومي') {
      query = 'SELECT username, xp FROM users ORDER BY xp DESC LIMIT 10';
    } else if (period === 'أسبوعي') {
      query = 'SELECT username, xp FROM users ORDER BY xp DESC LIMIT 10';
    } else if (period === 'شهري') {
      query = 'SELECT username, xp FROM users ORDER BY xp DESC LIMIT 10';
    }

    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/**
 * إضافة مهمة يومية للمستخدم
 * @param {string} userId - معرف المستخدم
 * @param {string} task - نص المهمة
 * @param {string} date - تاريخ المهمة (YYYY-MM-DD)
 * @returns {Promise} نتيجة الإضافة
 */
function addDailyTask(userId, task, date) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO daily_tasks (user_id, task, completed, date) VALUES (?, ?, 0, ?)',
      [userId, task, date],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * جلب المهام اليومية لمستخدم معين
 * @param {string} userId - معرف المستخدم
 * @param {string} date - تاريخ المهمة (YYYY-MM-DD)
 * @returns {Promise<array>} قائمة المهام
 */
function getDailyTasks(userId, date) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM daily_tasks WHERE user_id = ? AND date = ? ORDER BY id ASC',
      [userId, date],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

/**
 * إضافة تحذير للمستخدم
 * @param {string} userId - معرف المستخدم
 * @param {string} warnedBy - معرف من أعطى التحذير
 * @param {string} reason - السبب
 * @returns {Promise} نتيجة الإضافة
 */
function addWarning(userId, warnedBy, reason) {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    db.run(
      'INSERT INTO warnings (user_id, warned_by, reason, warned_at) VALUES (?, ?, ?, ?)',
      [userId, warnedBy, reason, now],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * الحصول على عدد التحذيرات للمستخدم
 * @param {string} userId - معرف المستخدم
 * @returns {Promise<number>} عدد التحذيرات
 */
function getUserWarnings(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM warnings WHERE user_id = ?', [userId], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.count : 0);
    });
  });
}

/**
 * الحصول على تفاصيل التحذيرات
 * @param {string} userId - معرف المستخدم
 * @returns {Promise<array>} قائمة التحذيرات
 */
function getWarningsDetails(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM warnings WHERE user_id = ? ORDER BY warned_at DESC', [userId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function getSetupConfig() {
  try {
    if (!fs.existsSync('./rolesetup.json')) return {};
    return JSON.parse(fs.readFileSync('./rolesetup.json', 'utf8')) || {};
  } catch (err) {
    console.error('خطأ في قراءة ملف التكوين:', err);
    return {};
  }
}

function saveSetupConfig(config) {
  try {
    fs.writeFileSync('./rolesetup.json', JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error('خطأ في حفظ ملف التكوين:', err);
    return false;
  }
}

function parseChannelIdFromString(text) {
  if (!text) return null;
  const mentionMatch = text.match(/<#(\d{17,20})>/);
  if (mentionMatch) return mentionMatch[1];
  const idMatch = text.match(/^(\d{17,20})$/);
  if (idMatch) return idMatch[1];
  const urlMatch = text.match(/discord(?:app)?\.com\/channels\/(?:\d{17,20})\/(\d{17,20})/i);
  if (urlMatch) return urlMatch[1];
  return null;
}

function getLogChannel(guild, type) {
  const config = getSetupConfig();
  if (!config) return null;

  let channelId = null;
  if (type === 'points') channelId = config.pointsLogChannelId;
  else if (type === 'voice') channelId = config.voiceLogChannelId;
  else if (type === 'reset') channelId = config.resetLogChannelId;
  else if (type === 'general') channelId = config.generalLogChannelId || config.logChannelId;

  if (!channelId) return null;
  return guild.channels.cache.get(channelId) || null;
}

function isBotAdmin(member) {
  if (!member) return false;
  const config = getSetupConfig();
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (config.adminRoleId && member.roles.cache.has(config.adminRoleId)) return true;
  return false;
}

async function sendLogEmbed(guild, type, embed) {
  const channel = getLogChannel(guild, type);
  if (!channel) return;
  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('خطأ في إرسال لوق:', err);
  }
}

// ============================================
// 📡 أحداث البوت (Events)
// ============================================

/**
 * حدث جاهزية البوت
 * يُشغّل عند اتصال البوت بنجاح بخادم ديسكورد
 */
client.once('ready', () => {
  console.log(`البوت جاهز ويعمل: ${client.user.tag}`);
  console.log('تم تحميل جميع الأوامر بنجاح!');
});

/**
 * حدث استقبال رسالة
 * يُشغّل عند إرسال أي رسالة في الخادم
 */
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const userId = message.author.id;
    const username = message.author.username;

    // أمر /تسطيب لإعداد رتبة المشرف أو قنوات اللوق
    if (message.content.startsWith('/تسطيب')) {
      try {
        if (!isBotAdmin(message.member)) {
          return message.reply('❌ فقط المسؤول أو رتبة المشرف المخصصة يمكنه استخدام أمر /تسطيب.');
        }

        const args = message.content.trim().split(/ +/);
        const target = args.slice(1).join(' ').trim();

        if (!target) {
          return message.reply('✅ استخدم `/تسطيب رتبة` أو `/تسطيب لوق نقاط` أو `/تسطيب لوق الفويس` أو `/تسطيب لوق التصفير`.');
        }

        const validTargets = ['رتبة', 'لوق نقاط', 'لوق الفويس', 'لوق التصفير'];
        if (!validTargets.includes(target)) {
          return message.reply('❌ الخيار غير صحيح. استخدم: `/تسطيب رتبة`, `/تسطيب لوق نقاط`, `/تسطيب لوق الفويس`, أو `/تسطيب لوق التصفير`.');
        }

        const filter = m => m.author.id === message.author.id && !m.author.bot;
        let prompt = '';

        if (target === 'رتبة') {
          prompt = '🛠️ أرسل آيدي الرتبة التي تريد تخصيصها كمشرف للبوت. هذه الرتبة لا تحتاج صلاحيات إدارة الخادم.';
        } else {
          prompt = '🛠️ أرسل آيدي قناة اللوق أو رابط القناة. ستُستخدم هذه القناة لإرسال لوق خاص بهذا النوع.';
        }

        message.reply(prompt + ' لديك 60 ثانية.');

        message.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] })
          .then(collected => {
            const value = collected.first().content.trim();
            const config = getSetupConfig();

            if (target === 'رتبة') {
              if (!/^[0-9]{17,20}$/.test(value)) {
                return message.reply('❌ آيدي الرتبة غير صحيح. يجب أن يكون أرقام فقط.');
              }
              config.adminRoleId = value;
              saveSetupConfig(config);
              return message.reply('✅ تم حفظ آيدي رتبة المشرف بنجاح. أصحاب هذه الرتبة يمكنهم استخدام أوامر الإدارة الآن.');
            }

            const channelId = parseChannelIdFromString(value);
            if (!channelId) {
              return message.reply('❌ لم يتم التعرف على قناة صحيحة. أرسل آيدي القناة أو رابط القناة.');
            }

            if (target === 'لوق نقاط') config.pointsLogChannelId = channelId;
            else if (target === 'لوق الفويس') config.voiceLogChannelId = channelId;
            else if (target === 'لوق التصفير') config.resetLogChannelId = channelId;

            saveSetupConfig(config);
            return message.reply(`✅ تم حفظ قناة ${target} بنجاح.`);
          })
          .catch(() => {
            message.reply('⏰ انتهى الوقت ولم يتم استلام الرد. أعد المحاولة.');
          });

        return;
      } catch (error) {
        console.error('خطأ في أمر /تسطيب:', error);
        message.reply('❌ حدث خطأ أثناء إعداد التكوين. يرجى المحاولة مرة أخرى.');
        return;
      }
    }

    // أمر /رانك: صورة ديناميكية احترافية مع تفاصيل المستخدم
    if (message.content.startsWith('/رانك')) {
      try {
        const { createCanvas, loadImage, registerFont } = require('canvas');

        // جلب بيانات المستخدم
        const userData = await getUserData(userId);
        if (!userData) return message.reply('❌ لم يتم العثور على بياناتك!');

        // جلب صورة المستخدم بحجم أكبر
        const avatarURL = message.author.displayAvatarURL({ extension: 'png', size: 512 });
        const userAvatar = await loadImage(avatarURL);

        // حساب البيانات
        const textXP = userData.xp;
        const voiceXP = userData.voice_time * 10; // 10 نقاط لكل دقيقة
        const adminPoints = userData.points;
        
        const textLevel = getLevel(textXP);
        const voiceLevel = getVoiceLevel(userData.voice_time);
        const adminLevel = Math.floor(adminPoints / 2500) + 1;

        // حساب نسب الأشرطة
        const textBarPercent = Math.min(textXP / 3000, 1) * 100;
        const voiceBarPercent = Math.min(voiceXP / 3000, 1) * 100;
        const adminBarPercent = Math.min(adminPoints / 2500, 1) * 100;

        // إنشاء الكانفاس (1232x688 مثل الصورة الأصلية)
        const canvas = createCanvas(1232, 688);
        const ctx = canvas.getContext('2d');

        // رابط صورة الخلفية من Imgbb (الرابط المباشر)
        const bgUrl = 'https://images2.imgbox.com/ef/3d/GfRPthHv_t.png';
        
        try {
          // محاولة تحميل الصورة من الرابط
          const bgImage = await loadImage(bgUrl);
          ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
        } catch (err) {
          // إذا فشل تحميل الصورة، استخدم gradient بديل
          console.log('تنبيه: لم يتم تحميل صورة الخلفية من الرابط، يتم استخدام الخلفية الملونة');
          const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
          gradient.addColorStop(0, '#8B4513'); // بني غامق
          gradient.addColorStop(0.5, '#CD7F32'); // برتقالي
          gradient.addColorStop(1, '#DAA520'); // ذهبي
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        // رسم عناصر ديكور (أشكال دائرية شفافة)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.beginPath();
        ctx.arc(100, 100, 150, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(1100, 600, 200, 0, Math.PI * 2);
        ctx.fill();

        // =============== صورة المستخدم بإطار دائري ===============
        const avatarX = 150;
        const avatarY = 150;
        const avatarSize = 200;
        const avatarRadius = avatarSize / 2;

        // رسم إطار خارجي برتقالي
        ctx.strokeStyle = '#FF8C00';
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius + 8, 0, Math.PI * 2);
        ctx.stroke();

        // رسم دائرة زرقاء خلف الصورة
        ctx.fillStyle = '#4080FF';
        ctx.beginPath();
        ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius, 0, Math.PI * 2);
        ctx.fill();

        // قص وضع صورة المستخدم بشكل دائري
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX + avatarRadius, avatarY + avatarRadius, avatarRadius - 4, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(userAvatar, avatarX, avatarY, avatarSize, avatarSize);
        ctx.restore();

        // =============== بيانات المستخدم على اليمين ===============
        const startY = 80;

        // اسم المستخدم
        ctx.font = 'bold 56px Arial';
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'right';
        ctx.fillText(`${message.author.username}#${message.author.discriminator}`, 1170, startY + 60);

        // =============== تفاعل صوتي (أول قسم) ===============
        let sectionY = startY + 120;

        // عنوان
        ctx.font = 'bold 36px Arial';
        ctx.fillStyle = '#FF8C00';
        ctx.textAlign = 'right';
        ctx.fillText('تفاعل صوتي 🎤', 1170, sectionY);

        // شريط التقدم
        const barX = 450;
        const barY = sectionY + 20;
        const barWidth = 550;
        const barHeight = 20;

        // خلفية الشريط
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.fillRect(barX, barY, barWidth, barHeight);

        // شريط التقدم (برتقالي)
        ctx.fillStyle = '#FF8C00';
        ctx.fillRect(barX, barY, barWidth * (voiceBarPercent / 100), barHeight);

        // XP والمستوى
        ctx.font = 'bold 20px Arial';
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'left';
        ctx.fillText(`XP: ${voiceXP}`, barX + 10, barY - 5);
        ctx.textAlign = 'right';
        ctx.fillText(`مستوى صوتي: ${voiceLevel}`, 1170, barY + 35);

        // =============== تفاعل كتابي (ثاني قسم) ===============
        sectionY += 100;

        // عنوان
        ctx.font = 'bold 36px Arial';
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'right';
        ctx.fillText('تفاعل كتابي 💬', 1170, sectionY);

        // شريط التقدم
        const barY2 = sectionY + 20;

        // خلفية الشريط
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.fillRect(barX, barY2, barWidth, barHeight);

        // شريط التقدم (أبيض)
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(barX, barY2, barWidth * (textBarPercent / 100), barHeight);

        // XP والمستوى
        ctx.font = 'bold 20px Arial';
        ctx.fillStyle = '#FF8C00';
        ctx.textAlign = 'left';
        ctx.fillText(`XP: ${textXP}`, barX + 10, barY2 - 5);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(`مستوى كتابي: ${textLevel}`, 1170, barY2 + 35);

        // =============== نقاط إدارية (ثالث قسم) ===============
        sectionY += 100;

        // عنوان
        ctx.font = 'bold 36px Arial';
        ctx.fillStyle = '#FF8C00';
        ctx.textAlign = 'right';
        ctx.fillText('نقاط إدارية ⭐', 1170, sectionY);

        // شريط التقدم
        const barY3 = sectionY + 20;

        // خلفية الشريط
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.fillRect(barX, barY3, barWidth, barHeight);

        // شريط التقدم (برتقالي)
        ctx.fillStyle = '#FF8C00';
        ctx.fillRect(barX, barY3, barWidth * (adminBarPercent / 100), barHeight);

        // النقاط والمستوى
        ctx.font = 'bold 20px Arial';
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'left';
        ctx.fillText(`نقاط: ${adminPoints}، مستوى: ${adminLevel}`, barX + 10, barY3 - 5);

        // إرسال الصورة
        const attachment = { files: [{ attachment: canvas.toBuffer(), name: 'rank.png' }] };
        message.channel.send(attachment);
        return;
      } catch (error) {
        console.error('خطأ في أمر /رانك:', error);
        message.reply('❌ حدث خطأ أثناء إنشاء صورة الرانك. تأكد من تثبيت مكتبة canvas: `npm install canvas`');
        return;
      }
    }

    // إضافة المستخدم إذا لم يكن موجوداً
    await addUser(userId, username);

    // إضافة XP للرسائل (10 XP لكل رسالة مع فترة راحة دقيقة واحدة)
    const now = Date.now();
    const userData = await getUserData(userId);

    if (!userData || now - userData.last_message_time > 60000) { // فترة راحة دقيقة واحدة
      const currentXP = userData ? userData.xp : 0;
      await updateUserData(userId, {
        xp: currentXP + 10,
        last_message_time: now
      });
    }

    // معالجة الأوامر
    if (message.content.startsWith('/')) {
      const args = message.content.slice(1).trim().split(/ +/);
      const command = args.shift().toLowerCase();

      try {
        switch (command) {
          case 'مساعدة':
          case 'help':
            const helpEmbed = new EmbedBuilder()
              .setTitle('🆘 قائمة المساعدة - أوامر البوت')
              .setDescription('جميع الأوامر المتاحة في البوت:')
              .setColor(0x00ff00)
              .addFields(
                {
                  name: '📋 أوامر عامة',
                  value:
                    '`/ملفي` - عرض ملفك الشخصي الكامل\n' +
                    '`/ملف @المستخدم` - عرض ملف أي مستخدم\n' +
                    '`/رانك` - عرض صورة رانك احترافية\n' +
                    '`/ترتيب يومي/أسبوعي/شهري` - لوحة الصدارة\n' +
                    '`/مهام` - عرض المهام اليومية\n' +
                    '`/مساعدة` - هذه القائمة'
                },
                {
                  name: '⚡ أوامر المشرفين',
                  value:
                    '`/إضافة نقاط @المستخدم [العدد]` - إضافة نقاط\n' +
                    '`/إزالة نقاط @المستخدم [العدد]` - إزالة نقاط\n' +
                    '`/تحذير @المستخدم [السبب]` - إعطاء تحذير\n' +
                    '`/تسطيب رتبة` - تعيين رتبة مشرف للبوت\n' +
                    '`/تسطيب لوق نقاط` - تعيين قناة لوق النقاط\n' +
                    '`/تسطيب لوق الفويس` - تعيين قناة لوق الفويس\n' +
                    '`/تسطيب لوق التصفير` - تعيين قناة لوق التصفير\n' +
                    '`/تصفير نقاط @المستخدم` - تصفير نقاط المستخدم\n' +
                    '`/تصفير الفويس @المستخدم` - تصفير وقت الصوت\n' +
                    '`/تصفير رانك @المستخدم` - تصفير الخبرة'
                }
              )
              .setFooter({ text: 'النقاط تُضاف يدويّاً من المشرفين فقط عبر أمر /إضافة نقاط' });

            message.channel.send({ embeds: [helpEmbed] });
            break;

          case 'ملفي':
          case 'profile':
            const userData = await getUserData(userId);
            const userRankXP = await getUserRank(userId, 'xp');
            const userRankPoints = await getUserRank(userId, 'points');

            if (!userData) {
              return message.reply('❌ لم يتم العثور على بياناتك!');
            }

            const profileEmbed = new EmbedBuilder()
              .setTitle(`👤 ملف ${message.author.username}`)
              .setThumbnail(message.author.displayAvatarURL())
              .setColor(0x0099ff)
              .addFields(
                { name: '⭐ المستوى', value: `${getLevel(userData.xp)}`, inline: true },
                { name: '🎯 النقاط', value: `${userData.points}`, inline: true },
                { name: '⚡ الخبرة', value: `${userData.xp}`, inline: true },
                { name: '🎤 وقت الصوت', value: `${Math.floor(userData.voice_time)} دقيقة`, inline: true },
                { name: '🏆 ترتيب الخبرة', value: `#${userRankXP}`, inline: true },
                { name: '💎 ترتيب النقاط', value: `#${userRankPoints}`, inline: true }
              )
              .setFooter({ text: 'استمر في التفاعل للحصول على المزيد من النقاط!' });

            message.channel.send({ embeds: [profileEmbed] });
            break;

          case 'ترتيب':
            const period = args[0];
            if (!['يومي', 'أسبوعي', 'شهري'].includes(period)) {
              return message.reply('❌ يرجى تحديد الفترة الصحيحة: `يومي` أو `أسبوعي` أو `شهري`');
            }

            const leaderboard = await getLeaderboard('xp', period);

            const embed = new EmbedBuilder()
              .setTitle(`🏆 لوحة الصدارة ${period}`)
              .setColor(0xffd700);

            let description = '';
            const medals = ['🥇', '🥈', '🥉'];

            leaderboard.forEach((user, index) => {
              const medal = index < 3 ? medals[index] : `**${index + 1}.**`;
              description += `${medal} ${user.username} - ${user.xp} نقطة خبرة\n`;
            });

            embed.setDescription(description || '📊 لا توجد بيانات متاحة حالياً');
            message.channel.send({ embeds: [embed] });
            break;

          case 'مهام':
          case 'tasks':
            try {
              const today = new Date().toISOString().split('T')[0];
              const dailyTasks = await getDailyTasks(message.author.id, today);

              if (dailyTasks.length === 0) {
                const noTasksEmbed = new EmbedBuilder()
                  .setTitle('📋 المهام اليومية')
                  .setDescription('لا توجد مهام مسجلة لليوم. استخدم `/إضافة مهمة` لإضافة مهامك.')
                  .setColor(0xffd700);

                message.channel.send({ embeds: [noTasksEmbed] });
                break;
              }

              const taskEmbed = new EmbedBuilder()
                .setTitle('📋 المهام اليومية')
                .setDescription(`تاريخ: **${today}**`)
                .setColor(0x00ff00);

              const preparedFields = dailyTasks.map((record, index) => ({
                name: `◽ مهمة ${index + 1}`,
                value: record.task,
                inline: false
              }));

              taskEmbed.addFields(preparedFields);
              message.channel.send({ embeds: [taskEmbed] });
            } catch (error) {
              console.error('خطأ في جلب المهام اليومية:', error);
              message.reply('❌ حدث خطأ أثناء جلب المهام اليومية. حاول مرة أخرى لاحقاً.');
            }
            break;

          case 'إضافة':
            // فحص الصلاحيات
            if (!isBotAdmin(message.member)) {
              return message.reply('❌ ليس لديك صلاحية استخدام هذا الأمر! (مطلوب: رتبة المشرف أو إدارة الخادم)');
            }

            if (args[0] === 'نقاط' && args[1]) {
              const targetUser = message.mentions.users.first();
              if (!targetUser) {
                return message.reply('❌ يرجى ذكر المستخدم المطلوب إضافة النقاط له!');
              }

              const points = parseInt(args[2]);
              if (isNaN(points) || points <= 0) {
                return message.reply('❌ يرجى إدخال عدد صحيح من النقاط!');
              }

              const userData = await getUserData(targetUser.id);
              const currentPoints = userData ? userData.points : 0;

              await updateUserData(targetUser.id, { points: currentPoints + points });

              const successEmbed = new EmbedBuilder()
                .setTitle('✅ تمت إضافة النقاط بنجاح!')
                .setDescription(`تم إضافة **${points}** نقطة إلى ${targetUser.username}`)
                .setColor(0x00ff00);

              message.channel.send({ embeds: [successEmbed] });

              const pointsLogEmbed = new EmbedBuilder()
                .setTitle('📥 لوق نقاط')
                .setDescription(`تم إضافة **${points}** نقطة إلى ${targetUser.toString()}`)
                .addFields(
                  { name: '👮 بواسطة', value: message.author.tag, inline: true },
                  { name: '🧾 المستخدم', value: targetUser.tag, inline: true }
                )
                .setColor(0x00ff00)
                .setTimestamp();

              sendLogEmbed(message.guild, 'points', pointsLogEmbed);
            } else if (args[0] === 'مهمة') {
              // /إضافة مهمة [المهام ...]
              const today = new Date().toISOString().split('T')[0];
              let taskText = args.slice(1).join(' ').trim();

              if (!taskText) {
                await message.reply('📌 أرسل الآن قائمة المهام اليومية مفصولة بـ `،` أو `,` (مثال: مهمة 1، مهمة 2، مهمة 3)');

                try {
                  const filter = (m) => m.author.id === message.author.id && !m.author.bot;
                  const collected = await message.channel.awaitMessages({ filter, max: 1, time: 120000, errors: ['time'] });
                  taskText = collected.first().content.trim();
                } catch (err) {
                  return message.reply('⏰ انتهى وقت الإدخال، يرجى إعادة المحاولة مرة أخرى.');
                }
              }

              const tasks = taskText
                .split(/[،,;]/)
                .map((t) => t.trim())
                .filter(Boolean);

              if (tasks.length === 0) {
                return message.reply('❌ لم يتم تحديد أي مهمة. الرجاء محاولة الأمر مرة أخرى.');
              }

              const addedTasks = [];
              for (const t of tasks) {
                await addDailyTask(message.author.id, t, today);
                addedTasks.push(t);
              }

              const panelEmbed = new EmbedBuilder()
                .setTitle('✅ تمت إضافة المهام اليومية')
                .setDescription(`تاريخ: **${today}**\nعدد المهام: **${addedTasks.length}**`)
                .setColor(0x00ff00)
                .addFields(
                  addedTasks.map((task, index) => ({
                    name: `◽ مهمة ${index + 1}`,
                    value: task,
                    inline: false
                  }))
                );

              message.channel.send({ embeds: [panelEmbed] });
            } else {
              message.reply('❌ استخدام خاطئ! الصيغة الصحيحة: `/إضافة نقاط @المستخدم [العدد]` أو `/إضافة مهمة [قائمة المهام]`');
            }
            break;

          case 'تصفير':
            if (!isBotAdmin(message.member)) {
              return message.reply('❌ ليس لديك صلاحية استخدام هذا الأمر! (مطلوب: رتبة المشرف أو إدارة الخادم)');
            }

            const resetType = args[0] ? args[0].toLowerCase() : null;
            const resetTargetUser = message.mentions.users.first();
            if (!resetTargetUser) {
              return message.reply('❌ يرجى ذكر المستخدم المطلوب تصفير بياناته. الصيغة: `/تصفير نقاط @المستخدم` أو `/تصفير الفويس @المستخدم` أو `/تصفير رانك @المستخدم`');
            }

            if (!['نقاط', 'الفويس', 'رانك'].includes(resetType)) {
              return message.reply('❌ الصيغة غير صحيحة. استخدم: `/تصفير نقاط @المستخدم`, `/تصفير الفويس @المستخدم`, أو `/تصفير رانك @المستخدم`.');
            }

            await addUser(resetTargetUser.id, resetTargetUser.username);
            const resetUserData = await getUserData(resetTargetUser.id);
            if (!resetUserData) {
              return message.reply('❌ لم يتم العثور على بيانات المستخدم.');
            }

            let updatedFields = {};
            let resetDescription = '';

            if (resetType === 'نقاط') {
              updatedFields = { points: 0 };
              resetDescription = `تم تصفير نقاط ${resetTargetUser.toString()}`;
            } else if (resetType === 'الفويس') {
              updatedFields = { voice_time: 0 };
              resetDescription = `تم تصفير وقت الصوت لـ ${resetTargetUser.toString()}`;
            } else if (resetType === 'رانك') {
              updatedFields = { xp: 0 };
              resetDescription = `تم تصفير الخبرة (الرانك) لـ ${resetTargetUser.toString()}`;
            }

            await updateUserData(resetTargetUser.id, updatedFields);

            const resetEmbed = new EmbedBuilder()
              .setTitle('♻️ تم التصفير')
              .setDescription(resetDescription)
              .addFields(
                { name: '👮 بواسطة', value: message.author.tag, inline: true },
                { name: '🧾 المستخدم', value: resetTargetUser.tag, inline: true },
                { name: '📌 النوع', value: resetType, inline: true }
              )
              .setColor(0xffa500)
              .setTimestamp();

            message.channel.send({ embeds: [resetEmbed] });
            sendLogEmbed(message.guild, 'reset', resetEmbed);
            break;

          case 'إزالة':
            // فحص الصلاحيات
            if (!isBotAdmin(message.member)) {
              return message.reply('❌ ليس لديك صلاحية استخدام هذا الأمر! (مطلوب: رتبة المشرف أو إدارة الخادم)');
            }

            if (args[0] === 'نقاط' && args[1]) {
              const targetUser = message.mentions.users.first();
              if (!targetUser) {
                return message.reply('❌ يرجى ذكر المستخدم المطلوب إزالة النقاط منه!');
              }

              const points = parseInt(args[2]);
              if (isNaN(points) || points <= 0) {
                return message.reply('❌ يرجى إدخال عدد صحيح من النقاط!');
              }

              const userData = await getUserData(targetUser.id);
              const currentPoints = userData ? userData.points : 0;

              if (currentPoints < points) {
                return message.reply('❌ المستخدم ليس لديه نقاط كافية!');
              }

              await updateUserData(targetUser.id, { points: currentPoints - points });

              const successEmbed = new EmbedBuilder()
                .setTitle('✅ تمت إزالة النقاط بنجاح!')
                .setDescription(`تم إزالة **${points}** نقطة من ${targetUser.username}`)
                .setColor(0xff0000);

              message.channel.send({ embeds: [successEmbed] });

              const pointsLogEmbed = new EmbedBuilder()
                .setTitle('📤 لوق نقاط')
                .setDescription(`تم إزالة **${points}** نقطة من ${targetUser.toString()}`)
                .addFields(
                  { name: '👮 بواسطة', value: message.author.tag, inline: true },
                  { name: '🧾 المستخدم', value: targetUser.tag, inline: true }
                )
                .setColor(0xff0000)
                .setTimestamp();

              sendLogEmbed(message.guild, 'points', pointsLogEmbed);
            } else {
              message.reply('❌ استخدام خاطئ! الصيغة الصحيحة: `/إزالة نقاط @المستخدم [العدد]`');
            }
            break;

          case 'ملف':
            // عرض ملف أي مستخدم آخر
            const mentionedUser = message.mentions.users.first();
            if (!mentionedUser) {
              return message.reply('❌ يرجى ذكر المستخدم المراد عرض ملفه! الصيغة: `/ملف @المستخدم`');
            }

            const otherUserData = await getUserData(mentionedUser.id);
            if (!otherUserData) {
              return message.reply('❌ لم يتم العثور على بيانات هذا المستخدم!');
            }

            const otherUserRankXP = await getUserRank(mentionedUser.id, 'xp');
            const otherUserRankPoints = await getUserRank(mentionedUser.id, 'points');
            const otherUserWarnings = await getUserWarnings(mentionedUser.id);

            const otherProfileEmbed = new EmbedBuilder()
              .setTitle(`👤 ملف ${mentionedUser.username}`)
              .setThumbnail(mentionedUser.displayAvatarURL())
              .setColor(0xFF8C00)
              .addFields(
                { name: '⭐ المستوى', value: `${getLevel(otherUserData.xp)}`, inline: true },
                { name: '🎯 النقاط', value: `${otherUserData.points}`, inline: true },
                { name: '⚡ الخبرة', value: `${otherUserData.xp}`, inline: true },
                { name: '🎤 وقت الصوت', value: `${Math.floor(otherUserData.voice_time)} دقيقة`, inline: true },
                { name: '🏆 ترتيب الخبرة', value: `#${otherUserRankXP}`, inline: true },
                { name: '💎 ترتيب النقاط', value: `#${otherUserRankPoints}`, inline: true },
                { name: '⚠️ التحذيرات', value: `${otherUserWarnings} تحذير`, inline: true }
              )
              .setFooter({ text: 'معلومات المستخدم من قاعدة البيانات' });

            message.channel.send({ embeds: [otherProfileEmbed] });
            break;

          case 'تحذير':
            // أمر التحذير (للمشرفين فقط)
            if (!isBotAdmin(message.member)) {
              return message.reply('❌ ليس لديك صلاحية استخدام هذا الأمر! (مطلوب: رتبة المشرف أو إدارة الخادم)');
            }

            const warnedUser = message.mentions.users.first();
            if (!warnedUser) {
              return message.reply('❌ يرجى ذكر المستخدم المراد تحذيره! الصيغة: `/تحذير @المستخدم [السبب]`');
            }

            // لا يمكن تحذير البوت أو المشرفين
            if (warnedUser.bot) {
              return message.reply('❌ لا يمكن تحذير بوت!');
            }

            // السبب اختياري
            const reason = args.slice(1).join(' ') || 'بدون سبب محدد';

            try {
              // إضافة التحذير إلى قاعدة البيانات
              await addUser(warnedUser.id, warnedUser.username);
              await addWarning(warnedUser.id, message.author.id, reason);

              // الحصول على عدد التحذيرات
              const warningsCount = await getUserWarnings(warnedUser.id);

              // حفظ في ملف تحذيرات
              const warningLog = {
                timestamp: new Date().toISOString(),
                warned_user: warnedUser.tag,
                warned_user_id: warnedUser.id,
                warned_by: message.author.tag,
                warned_by_id: message.author.id,
                reason: reason,
                total_warnings: warningsCount
              };

              // إضافة التحذير إلى ملف JSON
              let warningsFile = [];
              if (fs.existsSync('./warnings.json')) {
                warningsFile = JSON.parse(fs.readFileSync('./warnings.json', 'utf8'));
              }
              warningsFile.push(warningLog);
              fs.writeFileSync('./warnings.json', JSON.stringify(warningsFile, null, 2));

              // رسالة التحذير
              const warningEmbed = new EmbedBuilder()
                .setTitle('⚠️ تحذير جديد')
                .setDescription(`تم تحذير ${warnedUser.mention}`)
                .addFields(
                  { name: '👤 المستخدم', value: warnedUser.tag, inline: true },
                  { name: '🚨 السبب', value: reason, inline: true },
                  { name: '👮 من قبل', value: message.author.tag, inline: true },
                  { name: '📊 إجمالي التحذيرات', value: `${warningsCount}`, inline: true }
                )
                .setColor(0xFF0000)
                .setFooter({ text: 'تم حفظ التحذير في السجل' });

              message.channel.send({ embeds: [warningEmbed] });

              // محاولة إرسال رسالة للمستخدم المحذر
              try {
                await warnedUser.send({
                  embeds: [
                    new EmbedBuilder()
                      .setTitle('⚠️ لقد تم تحذيرك')
                      .setDescription(`تحذير من ${message.guild.name}`)
                      .addFields(
                        { name: '🚨 السبب', value: reason },
                        { name: '📊 عدد التحذيرات', value: `${warningsCount}` }
                      )
                      .setColor(0xFF0000)
                  ]
                });
              } catch (err) {
                // قد لا يستطيع البوت إرسال رسالة خاصة
                console.log(`لم أستطع إرسال رسالة خاصة ل ${warnedUser.tag}`);
              }
            } catch (error) {
              console.error('خطأ في أمر التحذير:', error);
              message.reply('❌ حدث خطأ أثناء إعطاء التحذير. يرجى المحاولة مرة أخرى.');
            }
            break;

          default:
            message.reply('❌ أمر غير معروف! اكتب `/مساعدة` لعرض جميع الأوامر المتاحة.');
            break;
        }
      } catch (error) {
        console.error('خطأ في معالجة الأمر:', error);
        message.reply('❌ حدث خطأ أثناء تنفيذ الأمر. يرجى المحاولة مرة أخرى.');
      }
    }
  } catch (error) {
    console.error('خطأ عام في حدث الرسائل:', error);
    // لا نرسل رسالة هنا لأن message قد يكون غير متاح
  }
});

/**
 * حدث تحديث حالة الصوت
 * يُشغّل عند انضمام أو غادرة المستخدم الدردشة الصوتية
 */
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const userId = newState.member.id;
    const username = newState.member.user.username;

    await addUser(userId, username);

    if (!oldState.channel && newState.channel) {
      // انضم المستخدم للصوت
      voiceSessions.set(userId, {
        channelId: newState.channel.id,
        joinTime: Date.now()
      });
    } else if (oldState.channel && !newState.channel) {
      // غادر المستخدم الصوت
      const session = voiceSessions.get(userId);
      if (session) {
        const leaveTime = Date.now();
        const duration = Math.floor((leaveTime - session.joinTime) / 1000 / 60); // دقائق

        const userData = await getUserData(userId);
        const currentVoiceTime = userData ? userData.voice_time : 0;
        const currentXP = userData ? userData.xp : 0;

        // إضافة XP للفويس (10 XP لكل دقيقة) وتحديث وقت الصوت
        await updateUserData(userId, {
          voice_time: currentVoiceTime + duration,
          xp: currentXP + (duration * 10)
        });

        voiceSessions.delete(userId);
      }
    }
  } catch (error) {
    console.error('خطأ في حدث تحديث حالة الصوت:', error);
  }
});

// ============================================
// ⚠️ معالجة الأخطاء
// ============================================

/**
 * معالجة الأخطاء غير المتوقعة (unhandledRejection)
 */
process.on('unhandledRejection', (error) => {
  console.error('خطأ غير معالج (unhandledRejection):', error);
});

/**
 * معالجة الأخطاء غير المعالجة (uncaughtException)
 */
process.on('uncaughtException', (error) => {
  console.error('خطأ غير معالج (uncaughtException):', error);
  process.exit(1); // إنهاء العملية في حالة خطأ غير متوقع
});

// ============================================
// 🔑 تسجيل الدخول (Login)
// ============================================

client.login(TOKEN);
