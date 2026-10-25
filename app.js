/* Клиентское приложение. API подключается отдельно из fake-api.js. */
(function () {
    'use strict';
    const api = window.FakeApi;
    // Режим демонстрации позволяет искусственно отключить связь.
    let forceOffline = false;
    const root = document.getElementById('screen');
    if (!api || !root)
        return;
    const STORAGE = 'fueling.prototype.request.v2';
    const debugToggle = document.getElementById('offline-toggle');
    if (debugToggle)
        debugToggle.addEventListener('change', () => {
            forceOffline = debugToggle.checked;
            markOffline(forceOffline);
            render();
        });
    const fmt = n => Number(n || 0).toLocaleString('ru-RU', {
        maximumFractionDigits: 2
    });
    const money = n => fmt(n) + ' ₽';
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
    const calcKm = (a, b) => {
        let dy = (a.lat - b.lat) * 111, dx = (a.lon - b.lon) * 62;
        return Math.round(Math.hypot(dy, dx));
    };
    let state = {
        page: 'home', limitExpanded: false, trip: null, position: null, stations: [], station: null, fuel: 'diesel', pump: null, liters: 100, equipment: 'truck', order: null, pending: null, offline: false, busy: false, error: '', result: null, reason: ''
    };
    let timer = null;
    function setPending(obj) {
        state.pending = obj;
        if (obj)
            localStorage.setItem(STORAGE, JSON.stringify(obj));
        else
            localStorage.removeItem(STORAGE);
    }
    function getPending() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE) || 'null');
        }
        catch {
            return null;
        }
    }
    function msg(t) {
        state.error = t;
        render();
    }
    function isNetwork(e) {
        return e && e.code === 'NETWORK_ERROR';
    }
    function markOffline(v) {
        state.offline = v;
        document.getElementById('connectivity').textContent = v ? 'Связь нестабильна' : 'Связь есть';
        document.getElementById('connectivity').classList.toggle('off', v);
    }
    async function safe(fn) {
        try {
            const x = await fn();
            markOffline(false);
            return x;
        }
        catch (e) {
            if (isNetwork(e))
                markOffline(true);
            throw e;
        }
    }
    function button(label, fn, cls = '') {
        return `<button class="btn ${cls}" data-act="${fn}">${label}</button>`;
    }
    function back(page) {
        return `<button class="back" data-act="back:${page}">← Назад</button>`;
    }
    function frame(title, body, prev) {
        return `${prev ? back(prev) : ''}<h1 class="head">${title}</h1>${state.error ? `<div class="callout error">${esc(state.error)}</div>` : ''}${body}`;
    }
    function blocked() {
        return state.busy ? ' disabled' : '';
    }
    function render() {
        const s = state;
        let body = '';
        if (s.page === 'home') {
            const trip = s.trip;
            body = trip ? `
                <h1 class="head">Заправка в рейсе</h1>
                ${s.error ? `<div class="callout error">${esc(s.error)}</div>` : ''}
                <div class="card trip-card">
                    <div class="label">Текущий рейс · ${esc(trip.date)}</div>
                    <div class="route">${esc(trip.from)} → ${esc(trip.to)}</div>
                    <div class="small">Тягач ${esc(trip.truck)}${trip.trailer ? ' · прицеп ' + esc(trip.trailer) : ''}</div>
                </div>
                <div class="card limit-card">
                    <div class="label">Лимит на топливо</div>
                    <div class="sum">${money(trip.limitLeft)}</div>
                    <div class="small">из ${money(trip.limitTotal)}</div>
                    <div class="meter"><i style="width:${Math.max(0, Math.min(100, trip.limitLeft / trip.limitTotal * 100))}%"></i></div>
                    <button class="link limit-toggle" data-act="limit" aria-expanded="${s.limitExpanded}" aria-controls="limit-details">
                        Почему доступно меньше? <span aria-hidden="true">${s.limitExpanded ? '−' : '+'}</span>
                    </button>
                    ${s.limitExpanded ? `
                        <div class="limit-details" id="limit-details">
                            <div class="limit-detail-row"><span>Потрачено</span><strong>${money(trip.spentAmount)}</strong></div>
                            <div class="limit-detail-row"><span>Временно заблокировано</span><strong>${money(trip.heldAmount)}</strong></div>
                            <div class="limit-detail-row"><span>Доступно</span><strong>${money(trip.limitLeft)}</strong></div>
                            <p>Часть лимита уже использована на предыдущие заправки, а часть временно зарезервирована. Срок снятия блокировки зависит от подтверждения АЗС.</p>
                        </div>
                    ` : ''}
                </div>
                <div class="screen-bottom">
                    ${button('Заправиться', 'stations')}
                    <div class="secondary-actions">
                        <button class="link" data-act="reset">Сбросить демо</button>
                    </div>
                </div>
            ` : frame('Заправка в рейсе', '<div class="callout warn">Нет данных рейса. Проверьте связь.</div>' + button('Повторить', 'refresh'));
        }
        else if (s.page === 'limit') {
            body = frame('Куда ушёл лимит', s.trip ? `<div class="card"><div class="line"><span>Лимит на рейс</span><strong>${money(s.trip.limitTotal)}</strong></div><div class="line"><span>Уже потрачено</span><strong>${money(s.trip.spentAmount)}</strong></div><div class="line"><span>Временно заблокировано</span><strong>${money(s.trip.heldAmount)}</strong></div><hr><div class="line"><span>Доступно</span><strong>${money(s.trip.limitLeft)}</strong></div></div><div class="callout">Часть суммы может быть зарезервирована для незавершённой заправки. По словам диспетчера, прежняя блокировка обычно снимается после подтверждения АЗС. Срок возврата не гарантирован.</div>` : 'Не удалось получить лимит', 'home');
        }
        else if (s.page === 'stations') {
            const near = s.stations
                .slice()
                .sort((a, b) => calcKm(a, s.position) - calcKm(b, s.position))
                .slice(0, 12);
            body = frame('Выберите АЗС', `<p class="intro">Ближайшие станции по прямой. Уточняйте съезд и сторону дороги по указателям.</p>
                <div class="station-list">
                    ${near.map(st => `
                        <button class="station-card" data-act="station:${esc(st.id)}">
                            <div class="station-top">
                                <div class="station-main">
                                    <div class="station-brand">${esc(st.brand || 'АЗС')}</div>
                                    <div class="station-name">${esc(st.name)}</div>
                                    <div class="station-address">${esc(st.address)}</div>
                                </div>
                                <div class="station-arrow">›</div>
                            </div>
                            <div class="station-meta">
                                <div class="station-distance">📍 ≈ ${calcKm(st, s.position)} км</div>
                                <div class="station-price">
                                    <div class="station-price-label">Дизель</div>
                                    ${st.prices.diesel != null
                ? `<div class="station-price-value">${money(st.prices.diesel)}</div>`
                : `<div class="station-price-empty">Нет ДТ</div>`}
                                </div>
                            </div>
                        </button>
                    `).join('') || '<div class="callout">Список АЗС недоступен.</div>'}
                </div>`, 'home');
        }
        else if (s.page === 'setup') {
            let st = s.station;
            const fuel = st.fuels.find(x => x.code === s.fuel);
            const avail = st.pumps.filter(p => p.status === 'free' && p.fuels.includes(s.fuel));
            const pump = st.pumps.find(p => p.number === s.pump);
            const cost = Number(s.liters) * Number(fuel?.price || 0);
            const enough = s.trip && cost <= s.trip.limitLeft;
            const valid = Number.isFinite(s.liters) && s.liters >= st.litersMin && s.liters <= st.litersMax;
            body = frame('Настроить заправку', `<div class="card"><strong>${esc(st.name)}</strong><div class="small">${esc(st.address)}</div></div><div class="label">1. Какое топливо?</div><div class="grid">${st.fuels.map(f => `<button class="choice ${s.fuel === f.code ? 'chosen' : ''}" data-act="fuel:${esc(f.code)}"><strong>${esc(f.name)}</strong><div class="small">${money(f.price)}/л</div></button>`).join('')}</div><p class="label">2. На какой колонке стоите?</p><div class="grid">${st.pumps.map(p => `<button class="choice ${s.pump === p.number ? 'chosen' : ''}" data-act="pump:${p.number}" ${p.status !== 'free' || !p.fuels.includes(s.fuel) ? 'disabled' : ''}><strong>${esc(p.displayName)}</strong> <span class="small">№ ${p.number}</span><div class="small">${p.status === 'off' ? 'Не работает' : p.status === 'busy' ? 'Занята' : !p.fuels.includes(s.fuel) ? 'Нет выбранного топлива' : 'Свободна'}</div></button>`).join('')}</div><p class="label">3. Сколько литров? (${st.litersMin}–${st.litersMax} л)</p><input id="liters" class="field" type="number" min="${st.litersMin}" max="${st.litersMax}" step="1" inputmode="numeric" value="${esc(s.liters)}"><div class="small">Стоимость: <strong>${money(cost)}</strong> · доступно ${money(s.trip?.limitLeft)}</div><p class="label" style="margin-top:17px">4. Что заправляем?</p><div class="grid"><button class="choice ${s.equipment === 'truck' ? 'chosen' : ''}" data-act="equipment:truck">Тягач</button><button class="choice ${s.equipment === 'refrigerator' ? 'chosen' : ''}" data-act="equipment:refrigerator">Рефрижератор</button></div>${!valid ? `<div class="callout warn">Введите от ${st.litersMin} до ${st.litersMax} литров.</div>` : ''}${!enough ? '<div class="callout warn">Недостаточно лимита. Уменьшите объём.</div>' : ''}${!avail.length ? '<div class="callout warn">Для этого топлива нет свободных колонок.</div>' : ''}<div class="actions"><button class="btn" data-act="confirm" ${(!pump || !valid || !enough || s.busy) ? 'disabled' : ''}>Проверить заказ</button></div>`, 'stations');
        }
        else if (s.page === 'confirm') {
            const st = s.station, f = st.fuels.find(x => x.code === s.fuel), p = st.pumps.find(x => x.number === s.pump), sum = s.liters * f.price;
            body = frame('Проверьте заказ', `<div class="card"><div class="line"><span>АЗС</span><strong>${esc(st.name)}</strong></div><div class="line"><span>Колонка</span><strong>${esc(p.displayName)} (№${p.number})</strong></div><div class="line"><span>Топливо</span><strong>${esc(f.name)}</strong></div><div class="line"><span>Оборудование</span><strong>${s.equipment === 'truck' ? 'Тягач' : 'Рефрижератор'}</strong></div><div class="line"><span>Объём</span><strong>${fmt(s.liters)} л</strong></div><div class="line"><span>Цена за литр</span><strong>${money(f.price)}</strong></div><hr><div class="line"><span>Будет зарезервировано</span><strong>${money(sum)}</strong></div></div><div class="callout warn">Убедитесь, что стоите у выбранной колонки. Если пропадёт связь, НЕ оформляйте второй заказ: приложение восстановит первый.</div><div class="actions">${button(s.busy ? 'Отправляем…' : 'Подтвердить заправку', 'submit')}${button('Изменить заказ', 'back:setup', 'alt')}</div>`);
        }
        else if (s.page === 'tracking') {
            const f = s.order;
            let status = f ? ({
                accepted: 'АЗС подтверждает заказ', waiting_nozzle: 'Вставьте пистолет', fueling: 'Идёт налив'
            })[f.status] : 'Проверяем заказ';
            const percentage = f ? Math.min(100, (f.currentLiters || 0) / f.liters * 100) : 0;
            const left = f?.nozzleDeadline ? Math.max(0, Math.ceil((f.nozzleDeadline - Date.now()) / 1000)) : null;
            body = frame('Заправка в процессе', `<div class="bigcenter"><div class="symbol">⛽</div><h2>${status || 'Уточняем состояние'}</h2><div class="small">${f ? `${esc(f.stationName)} · колонка № ${f.pump}` : 'Заказ мог быть создан даже без ответа'}</div></div>${f ? `<div class="card"><div class="line"><span>Залито</span><strong>${fmt(f.currentLiters)} / ${fmt(f.liters)} л</strong></div><div class="progress"><i style="width:${percentage}%"></i></div>${f.status === 'waiting_nozzle' && left !== null ? `<div class="callout warn">Вставьте пистолет. До автоматической отмены примерно ${left} сек.</div>` : ''}<div class="line"><span>Зарезервировано</span><strong>${money(f.amountHeld)}</strong></div></div>` : ''}${s.offline ? '<div class="callout warn">Связь прервалась. Заказ может выполняться на АЗС. Не создавайте новый. Последний известный статус показан выше.</div>' : ''}<div class="actions">${f && f.status === 'waiting_nozzle' ? button('Пистолет вставлен', 'insert-nozzle') : ''}${button(s.busy ? 'Проверяем…' : 'Обновить статус', 'poll', 'alt')}${f && ['accepted', 'waiting_nozzle', 'fueling'].includes(f.status) && f.currentLiters <= f.liters / 2 ? button('Отменить заправку', 'cancel', 'danger') : ''}</div>`);
        }
        else if (s.page === 'uncertain') {
            body = frame('Проверяем ваш заказ', `<div class="bigcenter"><div class="symbol">📶</div><h2>Ответ от сервера не получен</h2></div><div class="callout warn">Запрос мог дойти до АЗС. Не нажимайте «Заправиться» повторно и не создавайте новый заказ. Проверим его по исходному номеру запроса.</div><div class="actions">${button(s.busy ? 'Проверяем…' : 'Проверить тот же заказ', 'recover')}${button('Вернуться на главный экран', 'back:home', 'alt')}</div>`);
        }
        else if (s.page === 'result') {
            const f = s.result;
            const successful = f.status === 'completed';
            const partial = successful && f.factLiters < f.liters;
            const reasons = {
                DRIVER_CANCELLED: 'Отменена водителем',
                PUMP_TIMEOUT: 'Время ожидания пистолета истекло',
                STATION_NO_RESPONSE: 'АЗС не ответила'
            };
            const heading = successful ? (partial ? 'Заправлено меньше заказанного' : 'Заправка завершена') : 'Заправка отменена';
            body = `
                <div class="result-center">
                    <div class="okicon ${successful ? '' : 'cancel-icon'}">${successful ? '✓' : '!'}</div>
                    <div class="big">${heading}</div>
                    ${!successful ? `<div class="small result-reason">${reasons[f.reason] || 'Заказ отменён'}</div>` : ''}
                    <div class="card summary result-card">
                        <div class="line"><span>Заказано</span><strong>${fmt(f.liters)} л</strong></div>
                        <div class="line"><span>Залито</span><strong>${fmt(f.factLiters)} л</strong></div>
                        <div class="line"><span>Списано</span><strong>${money(f.factAmount)}</strong></div>
                        <div class="line"><span>Возвращено из резерва</span><strong>${money(f.amountHeld - f.factAmount)}</strong></div>
                        ${s.trip ? `<div class="line"><span>Остаток лимита</span><strong>${money(s.trip.limitLeft)}</strong></div>` : ''}
                    </div>
                    <div class="muted receipt-note">Чек ожидается от АЗС · диспетчер получит его позже</div>
                </div>
                <div class="screen-bottom">
                    ${button('На главную', 'finish')}
                </div>
            `;
        }
        root.innerHTML = body;
        const input = document.getElementById('liters');
        if (input)
            input.addEventListener('change', () => {
                state.liters = Number(input.value);
                render();
            });
    }
    function go(page) {
        state.page = page;
        state.error = '';
        render();
    }
    async function hydrate() {
        try {
            const [trip, position, stations] = await Promise.all([safe(() => api.getTrip()), safe(() => api.getDriverLocation()), safe(() => api.getStations())]);
            Object.assign(state, {
                trip, position, stations
            });
            return true;
        }
        catch (e) {
            msg('Нет связи. Попробуйте обновить данные.');
            return false;
        }
    }
    async function refreshTrip() {
        try {
            state.trip = await safe(() => api.getTrip());
            render();
        }
        catch (e) {
            if (!isNetwork(e))
                msg(e.message);
        }
    }
    async function boot() {
        state.pending = getPending();
        await hydrate();
        if (state.pending) {
            go('uncertain');
            await recover();
        }
        else {
            try {
                const active = await safe(() => api.getActiveFueling());
                if (active) {
                    state.order = active;
                    go('tracking');
                }
                else
                    go('home');
            }
            catch (e) {
                go('home');
            }
        }
        startPolling();
    }
    function startPolling() {
        if (timer)
            clearInterval(timer);
        timer = setInterval(async () => {
            if (state.busy)
                return;
            if (state.page === 'tracking')
                await poll();
            else if (state.page === 'uncertain')
                await recover();
            else if (state.page === 'home')
                render();
        }, 3500);
    }
    async function pickStation(id) {
        state.busy = true;
        render();
        try {
            const st = await safe(() => api.getStation(id));
            state.station = st;
            state.fuel = st.fuels.some(f => f.code === 'diesel') ? 'diesel' : st.fuels[0].code;
            state.pump = st.pumps.find(p => p.status === 'free' && p.fuels.includes(state.fuel))?.number || null;
            state.liters = Math.min(100, st.litersMax);
            go('setup');
        }
        catch (e) {
            msg(isNetwork(e) ? 'Нет связи при загрузке АЗС. Повторите выбор.' : e.message);
        }
        finally {
            state.busy = false;
            render();
        }
    }
    async function submit() {
        if (state.busy || state.pending)
            return;
        const st = state.station, f = st.fuels.find(x => x.code === state.fuel);
        const req = {
            stationId: st.id, pump: state.pump, fuel: state.fuel, liters: state.liters, price: f.price, equipmentType: state.equipment, clientRequestId: 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2)
        };
        setPending(req);
        state.busy = true;
        go('uncertain');
        try {
            const order = await safe(() => api.startFueling(req));
            state.order = order;
            go('tracking');
        }
        catch (e) {
            if (isNetwork(e)) {
                go('uncertain');
            }
            else {
                setPending(null);
                state.busy = false;
                if (e.code === 'PRICE_CHANGED') {
                    msg('Цена изменилась. Проверьте новую стоимость и подтвердите заказ заново.');
                    try {
                        state.station = await safe(() => api.getStation(st.id));
                    }
                    catch {
                    }
                    go('setup');
                    msg('Цена топлива изменилась. Проверьте актуальную стоимость и подтвердите снова.');
                }
                else if (e.code === 'ACTIVE_FUELING') {
                    go('uncertain');
                    msg('Уже есть незавершённый заказ. Проверяем его состояние.');
                }
                else {
                    go('setup');
                    msg(e.message);
                }
            }
        }
        finally {
            state.busy = false;
            render();
        }
    }
    async function recover() {
        if (state.busy)
            return;
        state.busy = true;
        render();
        try {
            const req = state.pending;
            if (!req) {
                const active = await safe(() => api.getActiveFueling());
                if (active) {
                    state.order = active;
                    go('tracking');
                }
                else
                    go('home');
                return;
            }
            let f = await safe(() => api.getFuelingByRequestId(req.clientRequestId));
            if (!f) {
                // Безопасно повторить тот же запрос: сервер распознаёт clientRequestId.
                try {
                    f = await safe(() => api.startFueling(req));
                }
                catch (e) {
                    if (isNetwork(e)) {
                        go('uncertain');
                        return;
                    }
                    if (e.code === 'PRICE_CHANGED' || e.code === 'PUMP_BUSY' || e.code === 'LIMIT_EXCEEDED' || e.code === 'ACTIVE_FUELING') {
                        if (e.code === 'ACTIVE_FUELING') {
                            const active = await safe(() => api.getActiveFueling());
                            if (active) {
                                state.order = active;
                                go('tracking');
                                return;
                            }
                        }
                        setPending(null);
                        go('setup');
                        msg(e.message);
                        return;
                    }
                    throw e;
                }
            }
            state.order = f;
            if (['completed', 'cancelled'].includes(f.status))
                await showResult(f);
            else
                go('tracking');
        }
        catch (e) {
            go('uncertain');
            msg(isNetwork(e) ? 'Связи пока нет. Повторная проверка безопасна.' : 'Проверка не удалась: ' + e.message);
        }
        finally {
            state.busy = false;
            render();
        }
    }
    async function showResult(f) {
        state.result = f;
        state.order = null;
        setPending(null);
        try {
            state.trip = await safe(() => api.getTrip());
        }
        catch (e) {
        }
        go('result');
    }
    async function poll() {
        if (!state.order || state.busy)
            return;
        state.busy = true;
        try {
            const f = await safe(() => api.getFueling(state.order.id));
            state.order = f;
            if (f.status === 'completed' || f.status === 'cancelled')
                await showResult(f);
            else
                render();
        }
        catch (e) {
            if (!isNetwork(e))
                msg(e.message);
            else
                render();
        }
        finally {
            state.busy = false;
        }
    }
    async function insertNozzle() {
        if (!state.order || state.busy || state.order.status !== 'waiting_nozzle')
            return;
        state.busy = true;
        try {
            const result = await safe(() => api.insertNozzle(state.order.id));
            state.order = result;
            if (result.status === 'completed' || result.status === 'cancelled') {
                await showResult(result);
            }
            else {
                render();
            }
        }
        catch (e) {
            if (isNetwork(e)) {
                // Ответ мог потеряться ПОСЛЕ подтверждения. Обновление статуса
                // покажет, произошла ли вставка; новый заказ не отправляем.
                msg('Не удалось получить ответ. Проверьте статус: пистолет мог быть подтверждён.');
            }
            else {
                msg(e.message);
                await poll();
            }
        }
        finally {
            state.busy = false;
            render();
        }
    }
    async function cancel() {
        if (!state.order || state.busy)
            return;
        if (!window.confirm('Отменить заправку? Уже налитое топливо будет оплачено.'))
            return;
        state.busy = true;
        try {
            const f = await safe(() => api.cancelFueling(state.order.id));
            await showResult(f);
        }
        catch (e) {
            if (isNetwork(e)) {
                go('tracking');
                msg('Связь пропала во время отмены. Проверяем статус, не создавайте новый заказ.');
            }
            else {
                go('tracking');
                msg(e.message);
            }
        }
        finally {
            state.busy = false;
            render();
        }
    }
    const errorText = e => isNetwork(e) ? 'Нет связи с сервером. Повторите действие после восстановления соединения.' : e.message;
    root.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-act]');
        if (!b || b.disabled)
            return;
        const action = b.dataset.act;
        if (state.busy && !['back:home'].includes(action))
            return;
        state.error = '';
        if (action.startsWith('back:')) {
            go(action.slice(5));
            return;
        }
        if (action.startsWith('fuel:')) {
            state.fuel = action.slice(5);
            state.pump = state.station.pumps.find(p => p.status === 'free' && p.fuels.includes(state.fuel))?.number || null;
            render();
            return;
        }
        if (action.startsWith('pump:')) {
            state.pump = Number(action.slice(5));
            render();
            return;
        }
        if (action.startsWith('equipment:')) {
            state.equipment = action.slice(10);
            render();
            return;
        }
        if (action.startsWith('station:')) {
            await pickStation(action.slice(8));
            return;
        }
        if (action === 'limit') {
            state.limitExpanded = !state.limitExpanded;
            render();
            return;
        }
        if (action === 'stations') {
            if (state.pending) {
                go('uncertain');
                return;
            }
            if (!state.stations.length) {
                await hydrate();
            }
            if (state.stations.length)
                go('stations');
            return;
        }
        if (action === 'refresh') {
            await hydrate();
            render();
            return;
        }
        if (action === 'confirm') {
            go('confirm');
            return;
        }
        if (action === 'submit') {
            await submit();
            return;
        }
        if (action === 'recover') {
            await recover();
            return;
        }
        if (action === 'poll') {
            await poll();
            return;
        }
        if (action === 'insert-nozzle') {
            await insertNozzle();
            return;
        }
        if (action === 'cancel') {
            await cancel();
            return;
        }
        if (action === 'finish' || action === 'another') {
            await refreshTrip();
            go(action === 'finish' ? 'home' : 'stations');
            return;
        }
        if (action === 'reset') {
            if (!window.confirm('Сбросить демо-заказы и лимит?'))
                return;
            api.reset();
            setPending(null);
            Object.assign(state, {
                order: null, result: null, trip: null
            });
            await hydrate();
            go('home');
        }
    });
    boot();
})();
