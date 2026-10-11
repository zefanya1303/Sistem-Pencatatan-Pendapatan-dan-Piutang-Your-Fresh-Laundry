(function () {
  "use strict";

  const VANISH_PER_KG = 3000;
  const AROMAS = ["Lavender", "Sakura", "Ocean Fresh", "Rose / Mawar", "Baby Soft", "Green Tea"];
  const LAUNDRY_STATUSES = ["Belum Selesai", "Selesai - Belum Diambil", "Sudah Diambil"];
  const config = window.YFL_SUPABASE_CONFIG || {};
  const supabaseConfigured = Boolean(config.url && config.anonKey && window.supabase);
  const client = supabaseConfigured
    ? window.supabase.createClient(config.url, config.anonKey)
    : null;
  const state = { customers: [], services: [], transactions: [], payments: [] };
  let toastTimer;
  let editingCustomerId = null;
  let deletingCustomerId = null;

  const money = (amount) => new Intl.NumberFormat("id-ID", {
    style: "currency", currency: "IDR", maximumFractionDigits: 0
  }).format(Number(amount) || 0);

  const todayLocal = () => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };

  const transactionDate = (transaction) => transaction.tanggal_transaksi
    || (transaction.created_at ? todayLocalFrom(new Date(transaction.created_at)) : "");

  const transactionSortKey = (transaction) => `${transactionDate(transaction)}T${transaction.jam_transaksi || "00:00"}|${transaction.created_at || ""}`;

  const safe = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);

  const customerFor = (transaction) => state.customers.find(
    (customer) => Number(customer.id_customer) === Number(transaction.id_customer)
  );
  const serviceFor = (transaction) => state.services.find(
    (service) => Number(service.id_jenis_cucian) === Number(transaction.id_jenis_cucian)
  );
  const transactionItemLabel = (transaction) => {
    const service = serviceFor(transaction);
    if (service) return service.nama_cucian;
    if (transaction.jenis_cucian === "Barang Khusus") {
      const legacyName = transaction.nama_barang === "Selimut" ? "Selimut Tipis" : transaction.nama_barang;
      return `Barang Khusus · ${legacyName}`;
    }
    return `${transaction.jenis_cucian || "Pakaian Biasa"} · ${transaction.jenis_laundry || "Layanan lama"}`;
  };
  const transactionQuantityLabel = (transaction) => {
    const service = serviceFor(transaction);
    const isSpecial = service ? service.satuan === "satuan" : transaction.jenis_cucian === "Barang Khusus";
    return isSpecial
      ? `${Number(transaction.jumlah ?? transaction.jumlah_satuan)} satuan`
      : `${Number(transaction.berat_kg)} kg`;
  };

  const paymentsFor = (transactionId) => state.payments.filter(
    (payment) => Number(payment.id_transaksi) === Number(transactionId)
  );

  const paidFor = (transactionId) => paymentsFor(transactionId).reduce(
    (sum, payment) => sum + Number(payment.jumlah_pembayaran), 0
  );

  const dueFor = (transaction) => Math.max(0, Number(transaction.total_pendapatan) - paidFor(transaction.id_transaksi));
  const laundryStatusFor = (transaction) => LAUNDRY_STATUSES.includes(transaction.status_cucian)
    ? transaction.status_cucian
    : LAUNDRY_STATUSES[0];

  function calculatePayment(transaction, received, method) {
    const outstanding = dueFor(transaction);
    const isCash = method === "Tunai";
    const amountToRecord = isCash ? Math.min(received, outstanding) : received;

    return {
      total: Number(transaction.total_pendapatan),
      received,
      cashIn: amountToRecord,
      change: isCash ? Math.max(0, received - outstanding) : 0,
      remaining: Math.max(0, outstanding - amountToRecord),
      exceedsBalance: !isCash && received > outstanding
    };
  }

  async function loadData() {
    if (!client) throw new Error("Supabase belum dikonfigurasi. Periksa URL dan anon key di backend/app.js.");

    const [customersResult, servicesResult, transactionsResult, paymentsResult] = await Promise.all([
      client.from("customers").select("*").order("nama_customer"),
      client.from("jenis_cucian").select("*").order("id_jenis_cucian"),
      client.from("transactions").select("*"),
      client.from("payments").select("*")
    ]);
    const failed = [customersResult, servicesResult, transactionsResult, paymentsResult].find((result) => result.error);
    if (failed) throw failed.error;
    state.customers = customersResult.data;
    state.services = servicesResult.data;
    state.transactions = transactionsResult.data.sort((a, b) => transactionSortKey(b).localeCompare(transactionSortKey(a)));
    state.payments = paymentsResult.data.sort((a, b) => String(b.tanggal_pembayaran || "").localeCompare(String(a.tanggal_pembayaran || "")));
  }

  async function insertRow(table, row) {
    if (!client) throw new Error("Koneksi Supabase tidak tersedia.");
    const { data, error } = await client.from(table).insert(row).select().single();
    if (error) throw error;
    return data;
  }

  async function updateRow(table, idField, id, values) {
    if (!client) throw new Error("Koneksi Supabase tidak tersedia.");
    const { data, error } = await client.from(table).update(values).eq(idField, id).select().single();
    if (error) throw error;
    return data;
  }

  async function deleteCustomer(id) {
    if (!client) throw new Error("Koneksi Supabase tidak tersedia.");
    const { data, error } = await client.from("customers").delete().eq("id_customer", id).select("id_customer").single();
    if (error) throw error;
    if (!data) throw new Error("Data pelanggan tidak ditemukan.");
  }

  function customerName(transaction) {
    const customer = customerFor(transaction);
    return customer ? customer.nama_customer : "Pelanggan tidak ditemukan";
  }

  function transactionStamp(transaction) {
    const date = transactionDate(transaction);
    const time = String(transaction.jam_transaksi || (transaction.created_at ? new Date(transaction.created_at).toTimeString().slice(0, 5) : "")).slice(0, 5);
    if (!date) return "-";
    const parsed = new Date(`${date}T00:00:00`);
    const formatted = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
    return `${formatted}${time ? ` · ${time}` : ""}`;
  }

  function paymentStamp(payment) {
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    }).format(new Date(payment.tanggal_pembayaran));
  }

  function statusMarkup(transaction) {
    const isPaid = dueFor(transaction) <= 0;
    return `<span class="status ${isPaid ? "status-paid" : "status-due"}"><span aria-hidden="true">${isPaid ? "🟢" : "🟡"}</span>${isPaid ? "Lunas" : "Belum Lunas"}</span>`;
  }

  function laundryStatusMarkup(transaction) {
    const status = laundryStatusFor(transaction);
    const className = status === "Sudah Diambil"
      ? "status-picked"
      : status === "Selesai - Belum Diambil" ? "status-ready" : "status-processing";
    const icon = status === "Sudah Diambil" ? "🟢" : status === "Selesai - Belum Diambil" ? "🟠" : "🔵";
    return `<span class="status ${className}"><span aria-hidden="true">${icon}</span>${safe(status)}</span>`;
  }

  function renderDashboard() {
    const todaysTransactions = state.transactions.filter((item) => transactionDate(item) === todayLocal());
    const todaysPayments = state.payments.filter((item) => {
      const date = new Date(item.tanggal_pembayaran);
      return todayLocalFrom(date) === todayLocal();
    });
    document.getElementById("today-revenue").textContent = money(todaysTransactions.reduce((sum, item) => sum + Number(item.total_pendapatan), 0));
    document.getElementById("total-receivable").textContent = money(state.transactions.reduce((sum, item) => sum + dueFor(item), 0));
    document.getElementById("today-cash").textContent = money(todaysPayments.reduce((sum, item) => sum + Number(item.jumlah_pembayaran), 0));
    document.getElementById("today-count").innerHTML = `${todaysTransactions.length} <small>transaksi</small>`;

    const recent = [...state.transactions].sort((a, b) => transactionSortKey(b).localeCompare(transactionSortKey(a))).slice(0, 6);
    document.getElementById("recent-transactions").innerHTML = recent.map((item) => `
      <tr><td><span class="table-primary">${safe(customerName(item))}</span></td>
      <td>${safe(transactionItemLabel(item))}</td><td>${safe(transactionStamp(item))}</td>
      <td class="amount-cell">${money(item.total_pendapatan)}</td><td>${statusMarkup(item)}</td></tr>`).join("");
    document.getElementById("recent-empty").classList.toggle("hidden", recent.length > 0);
  }

  function renderCustomers() {
    document.getElementById("customer-count").textContent = state.customers.length;
    document.getElementById("customer-list").innerHTML = state.customers.map((customer) => {
      const transactionCount = state.transactions.filter((transaction) => Number(transaction.id_customer) === Number(customer.id_customer)).length;
      return `<article class="customer-item"><span class="customer-avatar">${safe(customer.nama_customer.trim().slice(0, 1).toUpperCase())}</span>
        <span class="customer-detail"><strong>${safe(customer.nama_customer)}</strong><small>${safe(customer.nomor_telepon)}</small>
        <small>${safe(customer.alamat || "Alamat belum diisi")} · ${transactionCount} transaksi</small></span>
        <span class="customer-actions"><button class="customer-action edit-customer" type="button" data-customer-action="edit" data-customer-id="${safe(customer.id_customer)}">✏️ Edit</button>
        <button class="customer-action delete-customer" type="button" data-customer-action="delete" data-customer-id="${safe(customer.id_customer)}">🗑️ Hapus</button></span></article>`;
    }).join("");
    document.getElementById("customer-empty").classList.toggle("hidden", state.customers.length > 0);
    document.getElementById("transaction-customer").innerHTML = '<option value="">Pilih pelanggan</option>' + state.customers.map(
      (customer) => `<option value="${safe(customer.id_customer)}">${safe(customer.nama_customer)} · ${safe(customer.nomor_telepon)}</option>`
    ).join("");
  }

  function renderServices() {
    const select = document.getElementById("laundry-kind");
    const selected = select.value;
    select.innerHTML = '<option value="">Pilih jenis cucian</option>' + state.services.map((service) => `
      <option value="${safe(service.id_jenis_cucian)}"
        data-category="${safe(service.kategori)}"
        data-unit="${safe(service.satuan)}"
        data-price="${Number(service.harga)}"
        data-days="${Number(service.estimasi_hari)}">
        ${safe(service.nama_cucian)} · ${money(service.harga)}/${safe(service.satuan)}
      </option>`
    ).join("");
    if (state.services.some((service) => String(service.id_jenis_cucian) === selected)) select.value = selected;
    else if (state.services.length > 0) select.value = String(state.services[0].id_jenis_cucian);
    if (state.services.length === 0) {
        document.getElementById("price-breakdown").textContent = "Layanan laundry belum tersedia";
        document.getElementById("transaction-total").textContent = money(0);
        return;
      }
    updateTransactionKindFields();
    updateEstimate();
  }

  function renderTransactions() {
    const sorted = [...state.transactions].sort((a, b) => transactionSortKey(b).localeCompare(transactionSortKey(a)));
    const paymentFilter = document.getElementById("filter-payment-status").value;
    const laundryFilter = document.getElementById("filter-laundry-status").value;
    const filtered = sorted.filter((item) => {
      const paymentStatus = dueFor(item) <= 0 ? "Lunas" : "Belum Lunas";
      return (paymentFilter === "all" || paymentStatus === paymentFilter)
        && (laundryFilter === "all" || laundryStatusFor(item) === laundryFilter);
    });
    document.getElementById("transactions-list").innerHTML = filtered.map((item) => {
      const due = dueFor(item);
      const laundryStatus = laundryStatusFor(item);
      const action = `<select class="status-select" data-status-transaction="${safe(item.id_transaksi)}" aria-label="Ubah status cucian untuk ${safe(customerName(item))}">
        ${LAUNDRY_STATUSES.map((status) => `<option value="${safe(status)}"${status === laundryStatus ? " selected" : ""}>${safe(status)}</option>`).join("")}
      </select>${laundryStatus === "Selesai - Belum Diambil" && due > 0 ? '<small class="action-warning">Cucian belum dapat diambil karena pembayaran belum lunas.</small>' : ""}`;
      return `<tr><td><span class="table-primary">${safe(customerName(item))}</span></td>
        <td>${safe(transactionItemLabel(item))}</td><td>${safe(transactionStamp(item))}</td><td>${safe(transactionQuantityLabel(item))}</td>
        <td class="amount-cell">${money(item.total_pendapatan)}</td><td>${money(paidFor(item.id_transaksi))}</td><td>${money(due)}</td>
        <td>${statusMarkup(item)}</td><td>${laundryStatusMarkup(item)}</td>
        <td>${safe(item.tanggal_selesai || "-")}</td><td><div class="table-action-cell">${action}</div></td></tr>`;
    }).join("");
    document.getElementById("transactions-empty").classList.toggle("hidden", filtered.length > 0);
    renderPaymentChoices();
    renderReport();
  }

  function renderPaymentChoices() {
    const outstanding = state.transactions.filter((item) => dueFor(item) > 0);
    const select = document.getElementById("payment-transaction");
    const selected = select.value;
    select.innerHTML = '<option value="">Pilih transaksi belum lunas</option>' + outstanding.map((item) => `
      <option value="${safe(item.id_transaksi)}">${safe(customerName(item))} · ${money(dueFor(item))} sisa</option>`).join("");
    if (outstanding.some((item) => String(item.id_transaksi) === selected)) select.value = selected;

    document.getElementById("due-list").innerHTML = outstanding.map((item) => `
      <div class="due-item"><span class="customer-avatar">◷</span><span class="due-detail"><strong>${safe(customerName(item))}</strong><small>${safe(transactionItemLabel(item))} · ${safe(transactionStamp(item))}</small></span><strong class="due-amount">${money(dueFor(item))}</strong></div>`).join("");
    document.getElementById("due-empty").classList.toggle("hidden", outstanding.length > 0);
    updatePaymentSummary();
  }

  function updatePaymentSummary() {
    const transaction = state.transactions.find((item) => String(item.id_transaksi) === document.getElementById("payment-transaction").value);
    const summary = document.getElementById("payment-summary");
    const result = document.getElementById("payment-result");
    summary.classList.toggle("hidden", !transaction);
    result.classList.toggle("hidden", !transaction);
    if (!transaction) {
      document.getElementById("save-payment-button").disabled = false;
      document.getElementById("payment-validation").classList.add("hidden");
      return;
    }
    document.getElementById("payment-total").textContent = money(transaction.total_pendapatan);
    document.getElementById("payment-paid").textContent = money(paidFor(transaction.id_transaksi));
    document.getElementById("payment-due").textContent = money(dueFor(transaction));
    updatePaymentPreview(transaction);
  }

  function updatePaymentPreview(transaction) {
    const received = Math.max(0, Number(document.getElementById("payment-amount").value) || 0);
    const method = document.querySelector('#payment-form [name="metode_pembayaran"]').value;
    const payment = calculatePayment(transaction, received, method);
    document.getElementById("preview-total").textContent = money(payment.total);
    document.getElementById("preview-received").textContent = money(payment.received);
    document.getElementById("preview-cash").textContent = money(payment.cashIn);
    document.getElementById("preview-change").textContent = money(payment.change);
    document.getElementById("preview-due").textContent = money(payment.remaining);
    document.getElementById("preview-change-row").classList.toggle("hidden", method !== "Tunai");
    document.getElementById("payment-validation").classList.toggle("hidden", !payment.exceedsBalance);
    document.getElementById("save-payment-button").disabled = payment.exceedsBalance;
    document.getElementById("preview-status").textContent = payment.exceedsBalance
      ? "Melebihi sisa tagihan"
      : payment.remaining === 0 ? "Lunas" : "Belum Lunas";
  }

  function renderPayments() {
    const rows = [...state.payments].sort((a, b) => String(b.tanggal_pembayaran).localeCompare(String(a.tanggal_pembayaran)));
    document.getElementById("payments-list").innerHTML = rows.map((payment) => {
      const transaction = state.transactions.find((item) => Number(item.id_transaksi) === Number(payment.id_transaksi));
      return `<tr><td class="table-primary">${safe(transaction ? customerName(transaction) : "Pelanggan")}</td><td>${safe(paymentStamp(payment))}</td><td>${safe(payment.metode_pembayaran)}</td><td class="amount-cell">${money(payment.jumlah_pembayaran)}</td></tr>`;
    }).join("");
  }

  function renderReport() {
    const totalRevenue = state.transactions.reduce((sum, item) => sum + Number(item.total_pendapatan), 0);
    const totalCash = state.payments.reduce((sum, item) => sum + Number(item.jumlah_pembayaran), 0);
    const totalDue = state.transactions.reduce((sum, item) => sum + dueFor(item), 0);
    document.getElementById("report-revenue").textContent = money(totalRevenue);
    document.getElementById("report-cash").textContent = money(totalCash);
    document.getElementById("report-receivable").textContent = money(totalDue);
    document.getElementById("report-list").innerHTML = state.transactions.map((item) => `
      <tr><td><span class="table-primary">${safe(customerName(item))}</span><div class="table-secondary">${safe(transactionStamp(item))}</div></td>
      <td>${safe(transactionItemLabel(item))} · ${safe(transactionQuantityLabel(item))}</td><td class="amount-cell">${money(item.total_pendapatan)}</td>
      <td>${money(paidFor(item.id_transaksi))}</td><td>${money(dueFor(item))}</td><td>${statusMarkup(item)}</td></tr>`).join("");
    document.getElementById("report-empty").classList.toggle("hidden", state.transactions.length > 0);
  }

  function render() {
    renderDashboard();
    renderCustomers();
    renderServices();
    renderTransactions();
    renderPayments();
    renderReport();
  }

  function showMessage(message, isError) {
    const element = document.getElementById("app-message");
    element.textContent = message;
    element.classList.toggle("error", Boolean(isError));
    element.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.add("hidden"), 4000);
  }

  async function refreshData() {
    try {
      await loadData();
      const notice = document.getElementById("connection-notice");
      notice.classList.add("hidden");
      notice.textContent = "";
      render();
    } catch (error) {
      const notice = document.getElementById("connection-notice");
      notice.textContent = "Data belum dapat dimuat. Periksa koneksi internet atau konfigurasi Supabase.";
      notice.classList.remove("hidden");
    }
  }

  function navigate(pageName) {
    document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === `page-${pageName}`));
    document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.page === pageName));
    const activeLink = document.querySelector(`.nav-link[data-page="${pageName}"]`);
    document.getElementById("current-page-label").textContent = activeLink ? activeLink.dataset.pageLabel : "Dashboard";
  }

  function updateClock() {
    const now = new Date();
    const date = new Intl.DateTimeFormat("id-ID", {
      weekday: "long", day: "2-digit", month: "long", year: "numeric"
    }).format(now);
    const time = new Intl.DateTimeFormat("id-ID", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short"
    }).format(now);
    document.getElementById("date-label").textContent = date;
    document.getElementById("time-label").textContent = time;

    const hour = now.getHours();
    const greeting = hour < 11
      ? "Selamat Pagi!"
      : hour < 15
        ? "Selamat Siang!"
        : hour < 19
          ? "Selamat Sore!"
          : "Selamat Malam!";
    document.getElementById("greeting-title").innerHTML = `${greeting} <span class="wave">👋</span>`;
    document.getElementById("greeting-message").textContent = "Siap bekerja dan mencatat transaksi hari ini?";
  }

  function updateTransactionKindFields() {
    const service = state.services.find(
      (item) => String(item.id_jenis_cucian) === document.getElementById("laundry-kind").value
    );
    const isSpecial = service ? service.satuan === "satuan" : false;
    const weightInput = document.getElementById("laundry-weight");
    const quantityInput = document.getElementById("laundry-quantity");
    document.getElementById("weight-field").classList.toggle("hidden", isSpecial);
    document.getElementById("quantity-field").classList.toggle("hidden", !isSpecial);
    document.getElementById("vanish-field").classList.toggle("hidden", isSpecial);
    weightInput.required = !isSpecial;
    quantityInput.required = isSpecial;
    document.getElementById("vanish-option").value = isSpecial ? "false" : document.getElementById("vanish-option").value;
  }

  function updateEstimate() {
    const service = state.services.find(
      (item) => String(item.id_jenis_cucian) === document.getElementById("laundry-kind").value
    );
    if (!service) {
      document.getElementById("completion-estimate").textContent = "-";
      document.getElementById("price-breakdown").textContent = "Pilih jenis cucian";
      document.getElementById("transaction-total").textContent = money(0);
      return;
    }
    const isSpecial = service.satuan === "satuan";
    const quantity = Number(document.getElementById("laundry-quantity").value);
    const price = Number(service.harga);
    document.getElementById("completion-estimate").textContent = `${Number(service.estimasi_hari)} hari`;
    if (isSpecial) {
      if (!Number.isInteger(quantity) || quantity <= 0) {
        document.getElementById("price-breakdown").textContent = "Masukkan jumlah satuan";
        document.getElementById("transaction-total").textContent = money(0);
        return;
      }
      document.getElementById("price-breakdown").textContent = `${quantity} satuan × ${money(price)}/satuan (${service.nama_cucian})`;
      document.getElementById("transaction-total").textContent = money(quantity * price);
      return;
    }
    const weight = Number(document.getElementById("laundry-weight").value);
    const hasVanish = document.getElementById("vanish-option").value === "true";
    if (!weight || weight <= 0) {
      document.getElementById("price-breakdown").textContent = "Masukkan berat cucian";
      document.getElementById("transaction-total").textContent = money(0);
      return;
    }
    const base = Math.round(weight * price);
    const vanish = hasVanish ? Math.round(weight * VANISH_PER_KG) : 0;
    document.getElementById("price-breakdown").textContent = `${weight} kg × ${money(price)}/kg${hasVanish ? ` + Tambahan Vanish ${money(vanish)}` : ""}`;
    document.getElementById("transaction-total").textContent = money(base + vanish);
  }

  document.querySelectorAll(".nav-link").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.page)));
  document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.go)));

  document.getElementById("customer-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    try {
      const customerData = {
        nama_customer: String(fields.get("nama_customer")).trim(),
        alamat: String(fields.get("alamat")).trim(),
        nomor_telepon: String(fields.get("nomor_telepon")).trim()
      };
      const wasEditing = editingCustomerId !== null;
      if (wasEditing) {
        await updateRow("customers", "id_customer", editingCustomerId, customerData);
      } else {
        await insertRow("customers", customerData);
      }
      resetCustomerForm();
      await refreshData();
      showMessage(wasEditing ? "Data pelanggan berhasil diperbarui." : "Pelanggan berhasil disimpan.");
    } catch (error) {
      showMessage(`Data pelanggan gagal disimpan: ${error.message}`, true);
    }
  });

  function resetCustomerForm() {
    editingCustomerId = null;
    const form = document.getElementById("customer-form");
    form.reset();
    document.getElementById("customer-form-title").textContent = "Tambah Pelanggan";
    document.getElementById("save-customer-button").textContent = "＋ Simpan Pelanggan";
    document.getElementById("cancel-customer-edit").classList.add("hidden");
  }

  document.getElementById("customer-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-customer-action]");
    if (!button) return;
    const customerId = Number(button.dataset.customerId);
    const customer = state.customers.find((item) => Number(item.id_customer) === customerId);
    if (!customer) {
      showMessage("Data pelanggan tidak ditemukan. Muat ulang data dan coba kembali.", true);
      return;
    }
    if (button.dataset.customerAction === "edit") {
      editingCustomerId = customerId;
      const form = document.getElementById("customer-form");
      form.elements.nama_customer.value = customer.nama_customer;
      form.elements.nomor_telepon.value = customer.nomor_telepon;
      form.elements.alamat.value = customer.alamat || "";
      document.getElementById("customer-form-title").textContent = "Edit Data Pelanggan";
      document.getElementById("save-customer-button").textContent = "Simpan Perubahan";
      document.getElementById("cancel-customer-edit").classList.remove("hidden");
      form.scrollIntoView({ behavior: "smooth", block: "center" });
      form.elements.nama_customer.focus();
      return;
    }
    const hasTransactions = state.transactions.some((transaction) => Number(transaction.id_customer) === customerId);
    if (hasTransactions) {
      showMessage("Data pelanggan tidak dapat dihapus karena sudah memiliki riwayat transaksi.", true);
      return;
    }
    deletingCustomerId = customerId;
    document.getElementById("delete-confirm-message").textContent = "Apakah Anda yakin ingin menghapus data pelanggan ini?";
    document.getElementById("customer-delete-confirm").classList.remove("hidden");
  });

  document.getElementById("cancel-customer-edit").addEventListener("click", resetCustomerForm);
  document.getElementById("cancel-customer-delete").addEventListener("click", () => {
    deletingCustomerId = null;
    document.getElementById("customer-delete-confirm").classList.add("hidden");
  });
  document.getElementById("confirm-customer-delete").addEventListener("click", async () => {
    const customerId = deletingCustomerId;
    if (customerId === null) return;
    const hasTransactions = state.transactions.some((transaction) => Number(transaction.id_customer) === customerId);
    if (hasTransactions) {
      document.getElementById("customer-delete-confirm").classList.add("hidden");
      deletingCustomerId = null;
      showMessage("Data pelanggan tidak dapat dihapus karena sudah memiliki riwayat transaksi.", true);
      return;
    }
    try {
      await deleteCustomer(customerId);
      document.getElementById("customer-delete-confirm").classList.add("hidden");
      deletingCustomerId = null;
      if (editingCustomerId === customerId) resetCustomerForm();
      await refreshData();
      showMessage("Data pelanggan berhasil dihapus.");
    } catch (error) {
      document.getElementById("customer-delete-confirm").classList.add("hidden");
      deletingCustomerId = null;
      const isReferenced = error.code === "23503" || /foreign key|still referenced/i.test(error.message || "");
      showMessage(isReferenced
        ? "Data pelanggan tidak dapat dihapus karena sudah memiliki riwayat transaksi."
        : `Data pelanggan gagal dihapus: ${error.message}`, true);
    }
  });

  document.getElementById("transaction-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    if (!state.customers.some((item) => String(item.id_customer) === String(fields.get("id_customer")))) {
      showMessage("Pilih pelanggan yang terdaftar terlebih dahulu.", true);
      return;
    }
    const service = state.services.find((item) => String(item.id_jenis_cucian) === String(fields.get("id_jenis_cucian")));
    if (!service) {
      showMessage("Pilih jenis cucian yang tersedia di Supabase.", true);
      return;
    }
    const isSpecial = service.satuan === "satuan";
    const weight = isSpecial ? null : Number(fields.get("berat_kg"));
    const quantity = isSpecial ? Number(fields.get("jumlah")) : null;
    if (isSpecial && (!Number.isInteger(quantity) || quantity <= 0)) {
      showMessage("Masukkan jumlah satuan lebih dari 0.", true);
      return;
    }
    if (!isSpecial && (!Number.isFinite(weight) || weight <= 0)) {
      showMessage("Berat cucian harus lebih dari 0 kg.", true);
      return;
    }
    const usingVanish = !isSpecial && document.getElementById("vanish-option").value === "true";
    const vanish = usingVanish ? Math.round(weight * VANISH_PER_KG) : 0;
    const total = isSpecial ? quantity * Number(service.harga) : Math.round(weight * Number(service.harga)) + vanish;
    const serviceDays = Number(service.estimasi_hari);
    const finish = new Date();
    finish.setDate(finish.getDate() + serviceDays);
    try {
      await insertRow("transactions", {
        id_customer: Number(fields.get("id_customer")),
        id_jenis_cucian: Number(service.id_jenis_cucian),
        jumlah: quantity,
        berat_kg: weight,
        jenis_cucian: isSpecial ? "Barang Khusus" : service.nama_cucian,
        nama_barang: isSpecial ? service.nama_cucian : null,
        jumlah_satuan: isSpecial ? quantity : null,
        harga_per_satuan: isSpecial ? Number(service.harga) : null,
        jam_transaksi: new Date().toTimeString().slice(0,8),
        menggunakan_vanish: usingVanish,
        biaya_vanish_per_kg: VANISH_PER_KG,
        tambahan_vanish: vanish,
        total_pendapatan: total,
        status_pembayaran: "Belum Lunas",
        status_cucian: "Belum Selesai",
        tanggal_selesai: todayLocalFrom(finish),
        jenis_deterjen: "Deterjen Cair Laundry",
        jenis_pewangi: AROMAS.includes(String(fields.get("jenis_pewangi"))) ? String(fields.get("jenis_pewangi")) : AROMAS[0],
        keterangan: String(fields.get("keterangan")).trim()
      });
      form.reset();
      if (state.services.length > 0) {
        document.getElementById("laundry-kind").value = String(state.services[0].id_jenis_cucian);
      }
      updateTransactionKindFields();
      updateEstimate();
      await refreshData();
      showMessage("Transaksi laundry berhasil dicatat.");
    } catch (error) {
      showMessage(`Transaksi gagal disimpan: ${error.message}`, true);
    }
  });

  function todayLocalFrom(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  document.getElementById("payment-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const form = event.currentTarget;
    const transaction = state.transactions.find((item) => String(item.id_transaksi) === String(fields.get("id_transaksi")));
    const received = Number(fields.get("jumlah_pembayaran"));
    if (!transaction) {
      showMessage("Pilih transaksi yang belum lunas terlebih dahulu.", true);
      return;
    }
    if (!Number.isInteger(received) || received <= 0) {
      showMessage("Uang diterima harus berupa jumlah rupiah lebih dari Rp0.", true);
      return;
    }
    const method = String(fields.get("metode_pembayaran"));
    const payment = calculatePayment(transaction, received, method);
    if (payment.exceedsBalance) {
      showMessage("Untuk Transfer dan QRIS, jumlah pembayaran tidak boleh melebihi sisa tagihan.", true);
      return;
    }
    try {
      await insertRow("payments", {
        id_transaksi: Number(fields.get("id_transaksi")),
        jumlah_pembayaran: payment.cashIn,
        metode_pembayaran: method
      });
      form.reset();
      document.getElementById("payment-summary").classList.add("hidden");
      document.getElementById("payment-result").classList.add("hidden");
      await refreshData();
      showMessage(payment.change > 0
        ? `Pembayaran dicatat. Kas masuk ${money(payment.cashIn)} dan kembalian ${money(payment.change)}.`
        : `Pembayaran dicatat. Kas masuk ${money(payment.cashIn)}; sisa piutang ${money(payment.remaining)}.`);
    } catch (error) {
      showMessage(`Pembayaran gagal disimpan: ${error.message}`, true);
    }
  });

  document.getElementById("transactions-list").addEventListener("change", async (event) => {
    const select = event.target.closest("[data-status-transaction]");
    if (!select) return;
    const transaction = state.transactions.find((item) => String(item.id_transaksi) === select.dataset.statusTransaction);
    if (!transaction) {
      showMessage("Transaksi tidak ditemukan. Muat ulang data dan coba kembali.", true);
      return;
    }
    const currentStatus = laundryStatusFor(transaction);
    const nextStatus = select.value;
    if (nextStatus === "Sudah Diambil" && dueFor(transaction) > 0) {
      select.value = currentStatus;
      showMessage("Cucian belum dapat diambil karena pembayaran belum lunas.", true);
      return;
    }
    const nextAllowedStatus = currentStatus === "Belum Selesai"
      ? "Selesai - Belum Diambil"
      : currentStatus === "Selesai - Belum Diambil" && dueFor(transaction) <= 0
        ? "Sudah Diambil"
        : null;
    if (nextStatus !== nextAllowedStatus) {
      select.value = currentStatus;
      showMessage("Perubahan status harus mengikuti alur proses cucian.", true);
      return;
    }
    try {
      await updateRow("transactions", "id_transaksi", transaction.id_transaksi, { status_cucian: nextStatus });
      await refreshData();
      showMessage(`Status cucian diperbarui menjadi "${nextStatus}".`);
    } catch (error) {
      select.value = currentStatus;
      showMessage(`Status cucian gagal diperbarui: ${error.message}`, true);
    }
  });

  ["laundry-kind", "laundry-weight", "laundry-quantity", "vanish-option"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateEstimate);
    document.getElementById(id).addEventListener("change", updateEstimate);
  });
  document.getElementById("laundry-kind").addEventListener("change", () => {
    updateTransactionKindFields();
    updateEstimate();
  });
  document.getElementById("payment-transaction").addEventListener("change", updatePaymentSummary);
  document.getElementById("payment-amount").addEventListener("input", () => {
    const transaction = state.transactions.find((item) => String(item.id_transaksi) === document.getElementById("payment-transaction").value);
    if (transaction) updatePaymentPreview(transaction);
    else document.getElementById("save-payment-button").disabled = false;
  });
  document.querySelector('#payment-form [name="metode_pembayaran"]').addEventListener("change", updatePaymentSummary);
  ["filter-payment-status", "filter-laundry-status"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderTransactions);
  });

  updateClock();
  setInterval(updateClock, 1000);
  updateEstimate();
  refreshData();
})();
