// index.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// --- Firebase Setup ---
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// === DASHBOARD INLINE KEYBOARD ===
const dashboardMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🏠 Home', callback_data: 'dash_home' },
        { text: '💵 Withdraw', callback_data: 'dash_withdraw' }
      ],
      [{ text: '📜 Payment History', callback_data: 'dash_history' }],
      [
        { text: '❓ Help', callback_data: 'dash_help' },
        { text: 'ℹ️ About', callback_data: 'dash_about' }
      ]
    ]
  }
};

// === ADMIN DASHBOARD ===
const adminMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✅ Approve Payments', callback_data: 'admin_approve' }],
      [{ text: '💵 Approve Withdrawals', callback_data: 'admin_withdraw' }],
      [{ text: '📂 View Users', callback_data: 'admin_users' }],
      [{ text: '📤 Broadcast Message', callback_data: 'admin_broadcast' }],
      [{ text: '⚡ Manual Updates', callback_data: 'admin_manual' }],
      [{ text: '📞 Send Comfort Call', callback_data: 'admin_call' }]
    ]
  }
};

// === STATE HOLDERS ===
const adminCallStates = {};      // for comfort call creation
const adminManualStates = {};    // for manual updates (balance, calls, subscription)

// --- Start Command ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `Welcome, ${msg.from.first_name}! 🎉\nThis is the Comfortly demo bot.\n\nWhat role would you like to play?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎙 Become a Talker', callback_data: 'become_talker' }],
          [{ text: '👂 I\'m a Listener', callback_data: 'become_listener' }]
        ]
      }
    }
  );
});

// --- Admin Command ---
bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== process.env.ADMIN_TELEGRAM_ID) {
    return bot.sendMessage(chatId, '❌ You are not authorized.');
  }
  bot.sendMessage(chatId, '🛠 Admin Dashboard', adminMenu);
});

// === Callback Query Handler ===
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const userRef = doc(db, 'users', String(chatId));
  const snap = await getDoc(userRef);

  // --- Admin section ---
  if (String(chatId) === process.env.ADMIN_TELEGRAM_ID) {
    switch (data) {
      case 'admin_call':
        adminCallStates[chatId] = { step: 'userId' };
        bot.sendMessage(chatId, '📞 Enter the User ID to send the Comfort Call to:');
        return bot.answerCallbackQuery(query.id);
      case 'admin_manual':
        adminManualStates[chatId] = { step: 'userId' };
        bot.sendMessage(chatId, '⚡ Enter the User ID to update:');
        return bot.answerCallbackQuery(query.id);
      default:
        break;
    }
  }

  // --- Onboarding for Talker ---
  if (data === 'become_talker') {
    if (!snap.exists() || !snap.data().ndaAccepted) {
      const ndaText = `
*Comfortly Non-Disclosure & Privacy Agreement*

By joining as a **Talker (Comfort Provider)** you agree to:
1️⃣ Confidentiality – no sharing or recording of any listener info.
2️⃣ Data Protection – never store or distribute listener data.
3️⃣ Professional Conduct – respectful, non-romantic communication.
4️⃣ Penalties – breach may result in ban, loss of earnings, legal action.

Tap *I Accept the NDA* to continue.
      `;
      bot.sendMessage(chatId, ndaText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '✅ I Accept the NDA', callback_data: 'accept_nda' }]]
        }
      });
      return;
    } else {
      bot.sendMessage(chatId, '✅ You have already accepted the NDA.');
    }
  }

  if (data === 'accept_nda') {
    await setDoc(userRef, { role: 'talker', ndaAccepted: true, awaitingName: true }, { merge: true });
    bot.sendMessage(
      chatId,
      'Thank you. Please enter your *full government-issued name* for payment and withdrawal records:',
      { parse_mode: 'Markdown' }
    );
  }

  // Interests selection
  if (snap.exists()) {
    const u = snap.data();
    if (u.awaitingInterests && data.startsWith('interest_')) {
      if (data !== 'interest_done') {
        const interest = data.replace('interest_', '');
        const interests = u.interests || [];
        if (!interests.includes(interest)) interests.push(interest);
        await updateDoc(userRef, { interests });
        bot.answerCallbackQuery(query.id, { text: `Added: ${interest}` });
        return;
      } else if (data === 'interest_done') {
        await updateDoc(userRef, { awaitingInterests: false });
        bot.sendMessage(
          chatId,
          `💳 *Subscription Required*

To activate your Talker account please complete a one-time payment.

Amount: *10,000 / month*`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🌐 Pay Online', url: 'https://flutterwave.com/pay/confortlyusa' }],
                [{ text: '🏦 Bank Transfer Details', callback_data: 'bank_details' }],
                [{ text: '📤 Upload Receipt', callback_data: 'upload_receipt' }]
              ]
            }
          }
        );
        return;
      }
    }
  }

  if (data === 'bank_details') {
    bot.sendMessage(
      chatId,
      '*Sterling Bank*\nAccount: *8817643076*\nName: *Comfortly USA FLW*',
      { parse_mode: 'Markdown' }
    );
  }

  // --- Admin approves payment ---
  if (data === 'approve_payment' && String(chatId) === process.env.ADMIN_TELEGRAM_ID) {
    const userId = query.message.caption?.match(/UserID:(\d+)/)?.[1];
    if (userId) {
      await updateDoc(doc(db, 'users', userId), {
        approved: true,
        awaitingApproval: false,
        balance: 0,
        calls: 0,
        subscriptionEnd: null,
        history: []
      });
      await bot.sendMessage(
        userId,
        '✅ Your payment is approved! Welcome aboard.\n\nHere is your dashboard:',
        { parse_mode: 'Markdown', ...dashboardMenu }
      );
      bot.answerCallbackQuery(query.id, { text: 'User approved & dashboard sent' });
    }
  }

  // === Dashboard Buttons ===
  if (data.startsWith('dash_')) {
    const userSnap = await getDoc(userRef);
    const userData = userSnap.exists() ? userSnap.data() : {};
    switch (data) {
      case 'dash_home':
        bot.sendMessage(
          chatId,
          `🏠 *Home*
Username: ${userData.govtName || 'N/A'}
Subscription End: ${userData.subscriptionEnd || 'N/A'}
Calls Made: ${userData.calls || 0}
Earnings: $${userData.balance || 0}`,
          { parse_mode: 'Markdown', ...dashboardMenu }
        );
        break;
      case 'dash_withdraw':
        bot.sendMessage(chatId, '💵 *Withdraw*\nSend your payout request to finance@comfortly.com',
          { parse_mode: 'Markdown', ...dashboardMenu });
        break;
      case 'dash_history':
        const h = (userData.history || [])
          .map((tx, i) => `${i + 1}. ${tx.date}: $${tx.amount}`)
          .join('\n') || 'No transactions yet.';
        bot.sendMessage(chatId, `📜 *Payment History*\n${h}`,
          { parse_mode: 'Markdown', ...dashboardMenu });
        break;
      case 'dash_help':
        bot.sendMessage(chatId, '❓ *Help*\nFor support, email support@comfortly.com or reply here.',
          { parse_mode: 'Markdown', ...dashboardMenu });
        break;
      case 'dash_about':
        bot.sendMessage(chatId, 'ℹ️ *About*\nComfortly connects Talkers with people seeking companionship and support.',
          { parse_mode: 'Markdown', ...dashboardMenu });
        break;
    }
    bot.answerCallbackQuery(query.id);
  }

  if (data === 'upload_receipt') {
    await updateDoc(doc(db, 'users', String(chatId)), { awaitingReceipt: true });
    bot.sendMessage(chatId, '📤 Please upload your payment receipt (photo or PDF).');
    bot.answerCallbackQuery(query.id);
  }
});

// --- Message Handler for Name, Nationality, Receipts & Admin States ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // === Admin Manual Update Steps ===
  if (String(chatId) === process.env.ADMIN_TELEGRAM_ID && adminManualStates[chatId]) {
    const s = adminManualStates[chatId];
    switch (s.step) {
      case 'userId':
        s.userId = msg.text.trim();
        s.step = 'balance';
        return bot.sendMessage(chatId, 'Enter new Balance amount:');
      case 'balance':
        s.balance = parseFloat(msg.text.trim());
        s.step = 'calls';
        return bot.sendMessage(chatId, 'Enter number of Calls made:');
      case 'calls':
        s.calls = parseInt(msg.text.trim(), 10);
        s.step = 'subscriptionEnd';
        return bot.sendMessage(chatId, 'Enter Subscription End date (YYYY-MM-DD):');
      case 'subscriptionEnd':
        await updateDoc(doc(db, 'users', s.userId), {
          balance: s.balance,
          calls: s.calls,
          subscriptionEnd: msg.text.trim()
        });
        delete adminManualStates[chatId];
        return bot.sendMessage(chatId, '✅ User details updated successfully!');
    }
  }

  // === Admin Comfort Call Steps ===
  if (String(chatId) === process.env.ADMIN_TELEGRAM_ID && adminCallStates[chatId]) {
    const s = adminCallStates[chatId];
    switch (s.step) {
      case 'userId':
        s.userId = msg.text.trim();
        s.step = 'name';
        return bot.sendMessage(chatId, 'Enter the participant\'s Name:');
      case 'name':
        s.name = msg.text.trim();
        s.step = 'topic';
        return bot.sendMessage(chatId, 'Enter the Topic for this Comfort Call:');
      case 'topic':
        s.topic = msg.text.trim();
        s.step = 'amount';
        return bot.sendMessage(chatId, 'Enter the Amount (in $) for this call:');
      case 'amount':
        s.amount = msg.text.trim();
        s.step = 'datetime';
        return bot.sendMessage(chatId, 'Enter the Date & Time (e.g., 2025-09-16 18:30):');
      case 'datetime':
        s.datetime = msg.text.trim();
        const userSnap = await getDoc(doc(db, 'users', s.userId));
        if (!userSnap.exists()) {
          delete adminCallStates[chatId];
          return bot.sendMessage(chatId, '❌ User not found.');
        }
        const messageText = `
📞 *Comfortly Call Alert*

Hello *${s.name}*,

You have an upcoming Comfort Call scheduled.

🗓 Date: ${s.datetime.split(' ')[0]}
⏰ Time: ${s.datetime.split(' ')[1]}
💬 Topic: ${s.topic}
💵 Amount: $${s.amount}

Please be ready at the scheduled time.
[Join Your Call](https://comfortly.com/call/${s.userId})

Thank you for connecting with Comfortly! 💛
        `;
        await bot.sendMessage(s.userId, messageText, { parse_mode: 'Markdown' });
        delete adminCallStates[chatId];
        return bot.sendMessage(chatId, '✅ Comfort Call sent successfully!');
    }
  }

  // === Regular user flow ===
  const userRef = doc(db, 'users', String(chatId));
  const snap = await getDoc(userRef);
  if (!snap.exists()) return;
  const u = snap.data();

  if (msg.text && !msg.text.startsWith('/')) {
    if (u.awaitingName) {
      await updateDoc(userRef, { govtName: msg.text.trim(), awaitingName: false, awaitingNationality: true });
      return bot.sendMessage(chatId, 'Great. What is your nationality?');
    }
    if (u.awaitingNationality) {
      await updateDoc(userRef, { nationality: msg.text.trim(), awaitingNationality: false, awaitingInterests: true });
      return bot.sendMessage(chatId, 'Select the comfort topics you’d like to handle.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Relationships', callback_data: 'interest_relationships' }],
            [{ text: '😌 Stress Relief', callback_data: 'interest_stress' }],
            [{ text: '🎯 Motivation', callback_data: 'interest_motivation' }],
            [{ text: '💼 Career', callback_data: 'interest_career' }],
            [{ text: '✅ Done', callback_data: 'interest_done' }]
          ]
        }
      });
    }
  }

  if (u.awaitingReceipt && (msg.photo || msg.document)) {
    const fileId = msg.photo
      ? msg.photo[msg.photo.length - 1].file_id
      : msg.document.file_id;
    await updateDoc(userRef, { paymentProof: fileId, awaitingReceipt: false, awaitingApproval: true });
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (msg.photo) {
      bot.sendPhoto(adminId, fileId, {
        caption: `Payment receipt from UserID:${chatId}`,
        reply_markup: {
          inline_keyboard: [[{ text: '✅ Approve Talker', callback_data: 'approve_payment' }]]
        }
      });
    } else if (msg.document) {
      bot.sendDocument(adminId, fileId, {
        caption: `Payment receipt from UserID:${chatId}`,
        reply_markup: {
          inline_keyboard: [[{ text: '✅ Approve Talker', callback_data: 'approve_payment' }]]
        }
      });
    }
    bot.sendMessage(chatId, '✅ Receipt received. We’ll notify you once approved.');
  }
});

console.log('Bot is running…');
