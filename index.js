// index.js
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs
} = require('firebase/firestore');
const express = require('express');

// --- Telegram Bot ---
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
const firebaseApp = initializeApp(firebaseConfig); // renamed to avoid collision
const db = getFirestore(firebaseApp);

// === INLINE MENUS ===
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

// === ADMIN STATE TRACKER ===
// adminStates[adminChatId] = { action: 'manual'|'call'|'broadcast', step: number|string, data: {...} }
const adminStates = {};

// --- /start ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `Welcome, ${msg.from.first_name}! 🎉\nThis is Comfortly.\n\nWhat role would you like to play?`,
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

// --- /admin (open admin dashboard) ---
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== process.env.ADMIN_TELEGRAM_ID) {
    return bot.sendMessage(chatId, '❌ You are not authorized.');
  }
  bot.sendMessage(chatId, '🛠 Admin Dashboard', adminMenu);
});

// --- callback_query handler (single place) ---
bot.on('callback_query', async (query) => {
  try {
    const chatId = query.message.chat.id;
    const data = query.data;

    // quick helper
    const isAdmin = String(chatId) === process.env.ADMIN_TELEGRAM_ID;
    const userRef = doc(db, 'users', String(chatId));
    const snap = await getDoc(userRef);
    const userData = snap.exists() ? snap.data() : null;

    // ---------- ADMIN ACTION TRIGGERS ----------
    if (isAdmin) {
      // open interactive admin flows
      if (data === 'admin_call') {
        adminStates[chatId] = { action: 'call', step: 'userId', data: {} };
        await bot.sendMessage(chatId, '📞 Send Comfort Call — Step 1/5\nEnter the *User ID* to send the Comfort Call to:', { parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(query.id);
      }
      if (data === 'admin_manual') {
        adminStates[chatId] = { action: 'manual', step: 'userId', data: {} };
        await bot.sendMessage(chatId, '⚡ Manual Update — Step 1/4\nEnter the *User ID* to update:', { parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(query.id);
      }
      if (data === 'admin_broadcast') {
        adminStates[chatId] = { action: 'broadcast', step: 'message', data: {} };
        await bot.sendMessage(chatId, '📤 Enter the message to broadcast to all users:');
        return bot.answerCallbackQuery(query.id);
      }
      if (data === 'admin_approve') {
        // list pending users
        const usersCol = collection(db, 'users');
        const userDocs = await getDocs(usersCol);
        const pending = [];
        userDocs.forEach(d => {
          const ud = d.data();
          if (ud.awaitingApproval) pending.push({ id: d.id, name: ud.govtName || 'N/A' });
        });
        if (pending.length === 0) {
          await bot.sendMessage(chatId, '✅ No users awaiting payment approval.');
        } else {
          for (const u of pending) {
            await bot.sendMessage(chatId, `User: *${u.name}*\nID: \`${u.id}\` — Payment pending`, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '✅ Approve', callback_data: `approve_${u.id}` }],
                  [{ text: '❌ Reject', callback_data: `reject_${u.id}` }]
                ]
              }
            });
          }
        }
        return bot.answerCallbackQuery(query.id);
      }
      if (data === 'admin_withdraw') {
        await bot.sendMessage(chatId, '💵 Withdrawals: feature coming — will list withdrawal requests here.');
        return bot.answerCallbackQuery(query.id);
      }
      if (data === 'admin_users') {
        await bot.sendMessage(chatId, '📂 Users: feature coming — will allow viewing user details and proofs.');
        return bot.answerCallbackQuery(query.id);
      }
    }

    // ---------- Approve / Reject specific user (admin inline buttons) ----------
    if (isAdmin && data.startsWith('approve_')) {
      const userId = data.split('_')[1];
      await updateDoc(doc(db, 'users', userId), { approved: true, awaitingApproval: false, balance: 0, calls: 0, subscriptionEnd: null, history: [] });
      await bot.sendMessage(userId, '✅ Your payment has been approved by admin. Welcome aboard!', { parse_mode: 'Markdown', ...dashboardMenu });
      await bot.sendMessage(chatId, `✅ User ${userId} approved.`);
      return bot.answerCallbackQuery(query.id);
    }

    if (isAdmin && data.startsWith('reject_')) {
      const userId = data.split('_')[1];
      await updateDoc(doc(db, 'users', userId), { approved: false, awaitingApproval: false });
      await bot.sendMessage(userId, '❌ Your payment was rejected. Please contact support.');
      await bot.sendMessage(chatId, `❌ User ${userId} rejected.`);
      return bot.answerCallbackQuery(query.id);
    }

    // ---------- Talker onboarding: NDA / interests / payment ----------
    if (data === 'become_talker') {
      if (!snap.exists() || !snap.data().ndaAccepted) {
        const ndaText = `
*Comfortly Non-Disclosure & Privacy Agreement*

By joining as a **Talker (Comfort Provider)** you agree to:
1️⃣ Confidentiality – do not share or record listener info.
2️⃣ Data Protection – never store or distribute listener data.
3️⃣ Professional Conduct – respectful, non-romantic communication.
4️⃣ Penalties – breach may result in ban, loss of earnings, legal action.

Tap *I Accept the NDA* to continue.
        `;
        await bot.sendMessage(chatId, ndaText, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '✅ I Accept the NDA', callback_data: 'accept_nda' }]] }
        });
      } else {
        await bot.sendMessage(chatId, '✅ You have already accepted the NDA.');
      }
      return bot.answerCallbackQuery(query.id);
    }

    if (data === 'accept_nda') {
      await setDoc(userRef, { role: 'talker', ndaAccepted: true, awaitingName: true }, { merge: true });
      await bot.sendMessage(chatId, 'Thank you. Please enter your *full government-issued name* for payment and withdrawal records:', { parse_mode: 'Markdown' });
      return bot.answerCallbackQuery(query.id);
    }

    // interest selection (only valid if user doc exists and awaitingInterests true)
    if (snap.exists() && snap.data().awaitingInterests && data && data.startsWith('interest_')) {
      if (data !== 'interest_done') {
        const interest = data.replace('interest_', '');
        const interests = snap.data().interests || [];
        if (!interests.includes(interest)) interests.push(interest);
        await updateDoc(userRef, { interests });
        await bot.answerCallbackQuery(query.id, { text: `Added: ${interest}` });
        return;
      } else {
        await updateDoc(userRef, { awaitingInterests: false });
        await bot.sendMessage(chatId, `💳 *Subscription Required*\n\nTo activate your Talker account please complete a one-time payment.\n\nAmount: *10,000 / month*`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🌐 Pay Online', url: 'https://flutterwave.com/pay/confortlyusa' }],
              [{ text: '🏦 Bank Transfer Details', callback_data: 'bank_details' }],
              [{ text: '📤 Upload Receipt', callback_data: 'upload_receipt' }]
            ]
          }
        });
        return bot.answerCallbackQuery(query.id);
      }
    }

    if (data === 'bank_details') {
      await bot.sendMessage(chatId, '*Sterling Bank*\nAccount: *8817643076*\nName: *Comfortly USA FLW*', { parse_mode: 'Markdown' });
      return bot.answerCallbackQuery(query.id);
    }

    // ---------- Upload receipt trigger ----------
    if (data === 'upload_receipt') {
      await updateDoc(doc(db, 'users', String(chatId)), { awaitingReceipt: true });
      await bot.sendMessage(chatId, '📤 Please upload your payment receipt (photo or PDF).');
      return bot.answerCallbackQuery(query.id);
    }

    // ---------- Dashboard buttons (for talkers) ----------
    if (data && data.startsWith('dash_')) {
      const userSnap = await getDoc(doc(db, 'users', String(chatId)));
      const ud = userSnap.exists() ? userSnap.data() : {};
      switch (data) {
        case 'dash_home':
          await bot.sendMessage(chatId,
            `🏠 *Home*\nUsername: ${ud.govtName || 'N/A'}\nSubscription End: ${ud.subscriptionEnd || 'N/A'}\nCalls Made: ${ud.calls || 0}\nEarnings: $${ud.balance || 0}`,
            { parse_mode: 'Markdown', ...dashboardMenu }
          );
          break;
        case 'dash_withdraw':
          await bot.sendMessage(chatId, '💵 *Withdraw*\nTo request a withdrawal, enter amount and bank details. (Admin will approve)', { parse_mode: 'Markdown', ...dashboardMenu });
          break;
        case 'dash_history':
          const hist = (ud.history || []).map((t, i) => `${i + 1}. ${t.date}: $${t.amount}`).join('\n') || 'No transactions yet.';
          await bot.sendMessage(chatId, `📜 *Payment History*\n${hist}`, { parse_mode: 'Markdown', ...dashboardMenu });
          break;
        case 'dash_help':
          await bot.sendMessage(chatId, '❓ *Help*\nEmail support@comfortly.com or reply here.', { parse_mode: 'Markdown', ...dashboardMenu });
          break;
        case 'dash_about':
          await bot.sendMessage(chatId, 'ℹ️ *About*\nComfortly connects Talkers with people seeking companionship and support.', { parse_mode: 'Markdown', ...dashboardMenu });
          break;
      }
      return bot.answerCallbackQuery(query.id);
    }

    // finish
    return bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('callback_query error', err);
    // if admin, report; otherwise ignore
    try { if (process.env.ADMIN_TELEGRAM_ID) bot.sendMessage(process.env.ADMIN_TELEGRAM_ID, `Error in callback: ${err.message}`); } catch (e) {}
  }
});

// --- single message handler (users & admin interactive flows) ---
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : null;
    const isAdmin = String(chatId) === process.env.ADMIN_TELEGRAM_ID;

    // If admin has an interactive state, handle it first
    if (isAdmin && adminStates[chatId]) {
      const st = adminStates[chatId];

      // --- BROADCAST ---
      if (st.action === 'broadcast' && st.step === 'message') {
        if (!text) return bot.sendMessage(chatId, 'Please send the message text (as plain text).');
        // send to all users
        const usersCol = collection(db, 'users');
        const userDocs = await getDocs(usersCol);
        for (const d of userDocs.docs) {
          try { await bot.sendMessage(d.id, `📢 Admin Broadcast:\n\n${text}`); } catch (e) { /* ignore recipients we cannot message */ }
        }
        delete adminStates[chatId];
        return bot.sendMessage(chatId, '✅ Broadcast sent to all users (attempted).');
      }

      // --- MANUAL UPDATE FLOW ---
      if (st.action === 'manual') {
        if (st.step === 'userId') {
          if (!text) return bot.sendMessage(chatId, 'Please provide a valid User ID.');
          st.data.userId = text;
          st.step = 'balance';
          return bot.sendMessage(chatId, 'Enter new Balance (number):');
        }
        if (st.step === 'balance') {
          const v = parseFloat(text);
          if (isNaN(v)) return bot.sendMessage(chatId, 'Invalid number. Enter balance again:');
          st.data.balance = v;
          st.step = 'calls';
          return bot.sendMessage(chatId, 'Enter number of Calls:');
        }
        if (st.step === 'calls') {
          const v = parseInt(text, 10);
          if (isNaN(v)) return bot.sendMessage(chatId, 'Invalid number. Enter calls again:');
          st.data.calls = v;
          st.step = 'subscriptionEnd';
          return bot.sendMessage(chatId, 'Enter subscription end date (YYYY-MM-DD) or `none`:');
        }
        if (st.step === 'subscriptionEnd') {
          const subEnd = text.toLowerCase() === 'none' ? null : text;
          await updateDoc(doc(db, 'users', st.data.userId), {
            balance: st.data.balance,
            calls: st.data.calls,
            subscriptionEnd: subEnd
          });
          delete adminStates[chatId];
          return bot.sendMessage(chatId, `✅ Updated user ${st.data.userId} successfully.`);
        }
      }

      // --- COMFORT CALL CREATION FLOW ---
      if (st.action === 'call') {
        if (st.step === 'userId') {
          if (!text) return bot.sendMessage(chatId, 'Please provide a valid User ID.');
          st.data.userId = text;
          st.step = 'name';
          return bot.sendMessage(chatId, 'Enter participant\'s *name* (for personalization):', { parse_mode: 'Markdown' });
        }
        if (st.step === 'name') {
          st.data.name = text || '';
          st.step = 'topic';
          return bot.sendMessage(chatId, 'Enter the *topic* for this Comfort Call:', { parse_mode: 'Markdown' });
        }
        if (st.step === 'topic') {
          st.data.topic = text || '';
          st.step = 'amount';
          return bot.sendMessage(chatId, 'Enter the *amount* the user is paying (in $):', { parse_mode: 'Markdown' });
        }
        if (st.step === 'amount') {
          st.data.amount = text || '';
          st.step = 'datetime';
          return bot.sendMessage(chatId, 'Enter the Date & Time (e.g., `2025-09-16 18:30`):', { parse_mode: 'Markdown' });
        }
        if (st.step === 'datetime') {
          st.data.datetime = text || '';
          // verify user exists
          const targetSnap = await getDoc(doc(db, 'users', st.data.userId));
          if (!targetSnap.exists()) {
            delete adminStates[chatId];
            return bot.sendMessage(chatId, '❌ Target user not found. Aborting.');
          }
          // Build professional notification
          const [datePart = st.data.datetime, timePart = ''] = st.data.datetime.split(' ');
          const messageText = `📞 *Comfortly Call Alert*\n\nHello *${st.data.name}*,\n\nYou have an upcoming Comfort Call scheduled.\n\n🗓 Date: ${datePart}\n⏰ Time: ${timePart}\n💬 Topic: ${st.data.topic}\n💵 Amount: $${st.data.amount}\n\nPlease be ready at the scheduled time.\n[Join Your Call](https://comfortly.com/call/${st.data.userId})\n\nThank you for connecting with Comfortly! 💛`;
          // send to user
          try {
            await bot.sendMessage(st.data.userId, messageText, { parse_mode: 'Markdown' });
            await bot.sendMessage(chatId, `✅ Comfort Call sent to ${st.data.userId}.`);
          } catch (e) {
            await bot.sendMessage(chatId, `⚠️ Could not send message to ${st.data.userId}. They might not have started the bot or blocked messages.`);
          }
          delete adminStates[chatId];
          return;
        }
      }
    }

    // --- Not an admin interactive message: proceed with normal user flows ---

    // ignore slash commands for normal handling
    if (text && text.startsWith('/')) return;

    // user doc (if exists)
    const userRef = doc(db, 'users', String(chatId));
    const snap = await getDoc(userRef);
    const u = snap.exists() ? snap.data() : null;

    // If user doesn't exist yet and they send text, create a minimal doc
    if (!u && text) {
      await setDoc(userRef, { createdAt: Date.now() }, { merge: true });
    }

    // handle onboarding text inputs for talker
    if (u && u.awaitingName && text) {
      await updateDoc(userRef, { govtName: text, awaitingName: false, awaitingNationality: true });
      return bot.sendMessage(chatId, 'Great. What is your nationality?');
    }
    if (u && u.awaitingNationality && text) {
      await updateDoc(userRef, { nationality: text, awaitingNationality: false, awaitingInterests: true });
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

    // Receipt upload handling (photos/documents) — store fileId and send to admin
    if (u && u.awaitingReceipt && (msg.photo || msg.document)) {
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
      await updateDoc(userRef, { paymentProof: fileId, awaitingReceipt: false, awaitingApproval: true });
      const adminId = process.env.ADMIN_TELEGRAM_ID;
      const caption = `Payment receipt from UserID:${chatId}`;
      if (msg.photo) {
        await bot.sendPhoto(adminId, fileId, {
          caption,
          reply_markup: { inline_keyboard: [[{ text: '✅ Approve Talker', callback_data: 'approve_payment' }, { text: '❌ Reject', callback_data: `reject_${chatId}` }]] }
        });
      } else {
        await bot.sendDocument(adminId, fileId, {
          caption,
          reply_markup: { inline_keyboard: [[{ text: '✅ Approve Talker', callback_data: 'approve_payment' }, { text: '❌ Reject', callback_data: `reject_${chatId}` }]] }
        });
      }
      return bot.sendMessage(chatId, '✅ Receipt received. We’ll notify you once approved.');
    }

  } catch (err) {
    console.error('message handler error', err);
    try { if (process.env.ADMIN_TELEGRAM_ID) bot.sendMessage(process.env.ADMIN_TELEGRAM_ID, `Error: ${err.message}`); } catch(e) {}
  }
});

// --- Express keep-alive endpoint (ONE express instance) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Comfortly bot is running!'));
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

console.log('Bot is running…');
