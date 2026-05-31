require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const Database = require('better-sqlite3');
const axios = require('axios');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

const db = new Database('./store.db');


  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, price INTEGER,
    stock TEXT, sold INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    balance INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT, user_id TEXT,
    product_id INTEGER, qty INTEGER,
    total INTEGER, status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT, user_id TEXT,
    amount INTEGER, status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

client.once('ready', () => {
  console.log(`Bot ${client.user.tag} siap!`);
  showStore();
});

async function showStore() {
  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_BUY);
    const messages = await channel.messages.fetch({ limit: 10 });
    messages.forEach(m => { if (m.author.bot) m.delete().catch(() => {}) });
    db.all('SELECT * FROM products', [], async (err, products) => {
      let desc = '';
      if (!products || products.length === 0) {
        desc = 'Belum ada produk tersedia.';
      } else {
        products.forEach(p => {
          const lines = p.stock ? p.stock.split('\n') : [];
          desc += `**${p.name}**\n`;
          desc += `➡️ Price: Rp ${p.price.toLocaleString()}\n`;
          desc += `➡️ Stock: ${lines.length}\n`;
          desc += `➡️ Sold: ${p.sold}\n\n`;
        });
      }
      const embed = new EmbedBuilder()
        .setTitle('🛒 SanZ Store')
        .setDescription(desc)
        .setColor(0x00ff00)
        .setFooter({ text: `Last updated: ${new Date().toLocaleString('id-ID')}` });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_buy')
          .setLabel('🛒 Beli Produk')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('btn_deposit')
          .setLabel('💳 Deposit QRIS')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('btn_balance')
          .setLabel('💰 Cek Balance')
          .setStyle(ButtonStyle.Secondary)
      );
      await channel.send({ embeds: [embed], components: [row] });
    });
  } catch (e) {
    console.log('Error showStore:', e.message);
  }
}

client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    if (interaction.customId === 'btn_deposit') {
      await interaction.reply({ content: '💳 Masukkan jumlah deposit (min Rp 5.000):', ephemeral: true });
      const filter = m => m.author.id === interaction.user.id;
      const collector = interaction.channel.createMessageCollector({ filter, time: 30000, max: 1 });
      collector.on('collect', async m => {
        m.delete().catch(() => {});
        const amount = parseInt(m.content);
        if (isNaN(amount) || amount < 5000) {
          return interaction.followUp({ content: '❌ Minimal deposit Rp 5.000!', ephemeral: true });
        }
        await createDeposit(interaction, amount);
      });
    }

    if (interaction.customId === 'btn_balance') {
      db.get('SELECT balance FROM users WHERE user_id = ?', [interaction.user.id], async (err, row) => {
        const balance = row ? row.balance : 0;
        await interaction.reply({ content: `💰 Balance kamu: **Rp ${balance.toLocaleString()}**`, ephemeral: true });
      });
    }

    if (interaction.customId === 'btn_buy') {
      db.all('SELECT * FROM products', [], async (err, products) => {
        if (!products || products.length === 0) {
          return interaction.reply({ content: '❌ Tidak ada produk tersedia!', ephemeral: true });
        }
        const options = products.map(p => ({
          label: p.name,
          description: `Rp ${p.price.toLocaleString()}`,
          value: String(p.id)
        }));
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_product')
            .setPlaceholder('Pilih produk...')
            .addOptions(options)
        );
        await interaction.reply({ content: '🛒 Pilih produk:', components: [row], ephemeral: true });
      });
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'select_product') {
      const productId = parseInt(interaction.values[0]);
      db.get('SELECT * FROM products WHERE id = ?', [productId], async (err, product) => {
        if (!product) return interaction.reply({ content: '❌ Produk tidak ditemukan!', ephemeral: true });
        const lines = product.stock ? product.stock.split('\n').filter(l => l.trim()) : [];
        if (lines.length === 0) return interaction.reply({ content: '❌ Stok habis!', ephemeral: true });
        db.get('SELECT balance FROM users WHERE user_id = ?', [interaction.user.id], async (err, userRow) => {
          const balance = userRow ? userRow.balance : 0;
          if (balance < product.price) {
            return interaction.reply({ content: `❌ Balance tidak cukup! Balance: Rp ${balance.toLocaleString()}, Harga: Rp ${product.price.toLocaleString()}`, ephemeral: true });
          }
          const newBalance = balance - product.price;
          db.run('INSERT OR REPLACE INTO users (user_id, balance) VALUES (?, ?)', [interaction.user.id, newBalance]);
          const item = lines[0];
          const newStock = lines.slice(1).join('\n');
          db.run('UPDATE products SET stock = ?, sold = sold + 1 WHERE id = ?', [newStock, productId]);
          const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
          db.run('INSERT INTO transactions (order_id, user_id, product_id, qty, total, status) VALUES (?, ?, ?, ?, ?, ?)',
            [orderId, interaction.user.id, productId, 1, product.price, 'success']);
          try {
            await interaction.user.send(`✅ **Pembelian Berhasil!**\n📦 Produk: ${product.name}\n🔑 Item: \`${item}\`\n💰 Total: Rp ${product.price.toLocaleString()}`);
          } catch (e) {}
          await interaction.reply({ content: '✅ Pembelian berhasil! Cek DM kamu!', ephemeral: true });
          const logsChannel = await client.channels.fetch(process.env.CHANNEL_LOGS_BUY);
          const logEmbed = new EmbedBuilder()
            .setTitle('🚨 PURCHASE SUCCESS!')
            .addFields(
              { name: '📦 Order', value: orderId },
              { name: '👤 Buyer', value: `<@${interaction.user.id}>` },
              { name: '🎁 Product', value: product.name },
              { name: '🔢 Total QTY', value: '1 item' },
              { name: '💰 Total Harga', value: `Rp ${product.price.toLocaleString()}` }
            )
            .setColor(0x00ff00);
          await logsChannel.send({ embeds: [logEmbed] });
          showStore();
        });
      });
    }
  }
});

async function createDeposit(interaction, amount) {
  const invoiceId = `INV-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
  const auth = Buffer.from(process.env.MIDTRANS_SERVER_KEY + ':').toString('base64');
  try {
    const response = await axios.post('https://api.sandbox.midtrans.com/v2/charge', {
      payment_type: 'qris',
      transaction_details: { order_id: invoiceId, gross_amount: amount },
      qris: { acquirer: 'gopay' }
    }, {
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }
    });
    const qrUrl = response.data.actions?.find(a => a.name === 'generate-qr-code')?.url;
    db.run('INSERT INTO deposits (invoice_id, user_id, amount) VALUES (?, ?, ?)', [invoiceId, interaction.user.id, amount]);
    const embed = new EmbedBuilder()
      .setTitle('💳 Pembayaran QRIS')
      .setDescription(`Scan QR untuk membayar **Rp ${amount.toLocaleString()}**`)
      .addFields(
        { name: 'Status', value: 'WAITING_PAYMENT' },
        { name: 'Invoice Code', value: invoiceId },
        { name: 'Nominal', value: `Rp ${amount.toLocaleString()}` }
      )
      .setImage(qrUrl)
      .setColor(0xffaa00)
      .setFooter({ text: 'Invoice berlaku 15-30 menit' });
    await interaction.user.send({ embeds: [embed] });
    await interaction.followUp({ content: '✅ Invoice QRIS dikirim ke DM kamu!', ephemeral: true });
    const checkInterval = setInterval(async () => {
      try {
        const statusRes = await axios.get(`https://api.sandbox.midtrans.com/v2/${invoiceId}/status`, {
          headers: { 'Authorization': `Basic ${auth}` }
        });
        if (statusRes.data.transaction_status === 'settlement' || statusRes.data.transaction_status === 'capture') {
          clearInterval(checkInterval);
          db.get('SELECT balance FROM users WHERE user_id = ?', [interaction.user.id], (err, row) => {
            const newBalance = (row ? row.balance : 0) + amount;
            db.run('INSERT OR REPLACE INTO users (user_id, balance) VALUES (?, ?)', [interaction.user.id, newBalance]);
          });
          db.run('UPDATE deposits SET status = ? WHERE invoice_id = ?', ['success', invoiceId]);
          await interaction.user.send(`✅ **Deposit Berhasil!**\n💰 Nominal: Rp ${amount.toLocaleString()}\n🧾 Invoice: ${invoiceId}`);
          const logsDepo = await client.channels.fetch(process.env.CHANNEL_LOGS_DEPO);
          const logEmbed = new EmbedBuilder()
            .setTitle('🚨 QRIS DEPOSIT SUCCESS!')
            .addFields(
              { name: '👤 User', value: `<@${interaction.user.id}>` },
              { name: '💵 Nominal', value: `Rp ${amount.toLocaleString()}` },
              { name: '🧾 Invoice', value: invoiceId }
            )
            .setColor(0x00ff00);
          await logsDepo.send({ embeds: [logEmbed] });
        }
      } catch (e) {}
    }, 10000);
    setTimeout(() => clearInterval(checkInterval), 1800000);
  } catch (error) {
    console.log('Error deposit:', error.message);
    await interaction.followUp({ content: '❌ Gagal membuat invoice! Coba lagi.', ephemeral: true });
  }
}

client.on('messageCreate', async msg => {
  if (msg.author.bot) return;

  if (msg.content.startsWith('!addproduct')) {
    const args = msg.content.slice(12).split('|');
    if (args.length < 3) return msg.reply('Format: !addproduct NamaProduk|Harga|stok1');
    const [name, price, ...stockArr] = args;
    const stock = stockArr.join('|');
    db.run('INSERT INTO products (name, price, stock) VALUES (?, ?, ?)',
      [name.trim(), parseInt(price), stock.trim()]);
    msg.reply(`✅ Produk **${name}** berhasil ditambahkan!`);
    showStore();
  }

  if (msg.content.startsWith('!addstock')) {
    const args = msg.content.slice(10).split('|');
    if (args.length < 2) return msg.reply('Format: !addstock NamaProduk|stok1');
    const [name, ...stockArr] = args;
    const newStock = stockArr.join('|');
    db.get('SELECT * FROM products WHERE name LIKE ?', [`%${name.trim()}%`], (err, product) => {
      if (!product) return msg.reply('❌ Produk tidak ditemukan!');
      const combined = product.stock ? product.stock + '\n' + newStock : newStock;
      db.run('UPDATE products SET stock = ? WHERE id = ?', [combined, product.id]);
      msg.reply(`✅ Stok **${product.name}** berhasil ditambahkan!`);
      showStore();
    });
  }

  if (msg.content.startsWith('!deleteproduct')) {
    const name = msg.content.slice(15).trim();
    if (!name) return msg.reply('Format: !deleteproduct NamaProduk');
    db.get('SELECT * FROM products WHERE name LIKE ?', [`%${name}%`], (err, product) => {
      if (!product) return msg.reply('❌ Produk tidak ditemukan!');
      db.run('DELETE FROM products WHERE id = ?', [product.id]);
      msg.reply(`✅ Produk **${product.name}** berhasil dihapus!`);
      showStore();
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
