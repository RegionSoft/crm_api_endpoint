// ws_client.js — WebSocket клиент для подключения in-house эндпоинта к crm_api
// Устанавливает исходящее WS-соединение к серверу crm_api,
// принимает запросы и выполняет их на локальном Express-сервере.
// Гарантирует персистентность: ping/pong мониторинг, авто-реконнект, защита от дублей.

const WebSocket = require('ws');
const http = require('http');

class WSClient {
  /**
   * @param {object} config
   * @param {string} config.serverUrl — URL WS-сервера crm_api (например wss://crmapi.regionsoft.ru/ws/endpoint)
   * @param {string} config.apikey — API-ключ базы
   * @param {string} config.secretkey — секретный ключ базы
   * @param {number} config.localPort — порт локального Express-сервера (по умолчанию 3061)
   */
  constructor(config) {
    this.serverUrl = config.serverUrl;
    this.apikey = config.apikey;
    this.secretkey = config.secretkey;
    this.localPort = config.localPort || 3061;

    this.ws = null;
    this.authenticated = false;
    this.shouldReconnect = true;

    // Reconnect: быстрый старт, низкий потолок — чтобы успеть подняться между retry сервера
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 5000;
    this._reconnectTimer = null;

    // Клиентский ping — проверяем, что сервер жив
    this._pingInterval = null;
    this._pongReceived = true;
    this.PING_INTERVAL = 25000;    // Пингуем каждые 25с
    this.PONG_TIMEOUT = 10000;     // Если pong не пришёл за 10с — соединение мёртвое

    // Защита от повторного connect()
    this._connecting = false;
  }

  /**
   * Подключиться к WS-серверу
   */
  connect() {
    // Защита от двойного подключения
    if (this._connecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this._connecting = true;
    this._cleanup();

    console.log(`[WS-Client] Connecting to ${this.serverUrl}...`);

    this.ws = new WebSocket(this.serverUrl, {
      handshakeTimeout: 10000,
    });
    this.authenticated = false;

    this.ws.on('open', () => {
      this._connecting = false;
      this.reconnectDelay = 1000; // Сбрасываем backoff при успешном подключении
      console.log('[WS-Client] Connected, authenticating...');

      // Отправляем аутентификацию
      this._safeSend({
        type: 'auth',
        apikey: this.apikey,
        secretkey: this.secretkey
      });
    });

    this.ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        console.error('[WS-Client] Invalid JSON from server:', e);
        return;
      }

      if (msg.type === 'auth_ok') {
        this.authenticated = true;
        console.log(`[WS-Client] Authenticated as ${msg.domain}`);
        // Запускаем клиентский ping только после аутентификации
        this._startPing();
        return;
      }

      if (msg.type === 'auth_error') {
        console.error('[WS-Client] Authentication failed:', msg.message);
        this.shouldReconnect = false; // Не реконнектимся при ошибке авторизации
        this.ws.close();
        return;
      }

      if (msg.type === 'error') {
        console.error('[WS-Client] Server error:', msg.message);
        return;
      }

      // Обработка входящего запроса от crm_api
      if (msg.type === 'request') {
        this._handleRequest(msg);
        return;
      }
    });

    // Отвечаем на серверный ping (ws делает это автоматически, но отслеживаем)
    this.ws.on('ping', () => {
      // ws библиотека автоматически отвечает pong
    });

    // Получаем pong на наш клиентский ping
    this.ws.on('pong', () => {
      this._pongReceived = true;
    });

    this.ws.on('close', (code, reason) => {
      this._connecting = false;
      const reasonStr = reason ? reason.toString() : 'no reason';
      console.log(`[WS-Client] Connection closed (code=${code}, reason=${reasonStr})`);
      this.authenticated = false;
      this._stopPing();
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this._connecting = false;
      console.error('[WS-Client] Connection error:', err.message);
      // error всегда сопровождается close, реконнект будет в close handler
    });
  }

  /**
   * Клиентский ping — активно проверяем, что соединение живое.
   * Серверный ping/pong недостаточен: если сервер зависнет или сеть "подвиснет"
   * (half-open connection), клиент не узнает об этом без собственного ping.
   */
  _startPing() {
    this._stopPing();
    this._pongReceived = true;

    this._pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this._stopPing();
        return;
      }

      if (!this._pongReceived) {
        // Сервер не ответил на предыдущий ping — соединение мёртвое
        console.log('[WS-Client] Pong timeout — connection is dead, reconnecting...');
        this._stopPing();
        this.ws.terminate(); // terminate вместо close — принудительный обрыв
        return;
      }

      this._pongReceived = false;
      this.ws.ping();
    }, this.PING_INTERVAL);
  }

  _stopPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  /**
   * Безопасная отправка — проверяем readyState перед send
   */
  _safeSend(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  /**
   * Очистка перед переподключением
   */
  _cleanup() {
    this._stopPing();
    if (this.ws) {
      // Убираем все слушатели, чтобы старый ws не вызывал _scheduleReconnect повторно
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      }
      this.ws = null;
    }
  }

  /**
   * Обработка входящего запроса — перенаправляем на локальный Express-сервер
   */
  async _handleRequest(msg) {
    const { requestId, url, body, responseType } = msg;

    try {
      const result = await this._forwardToLocal(url, body, responseType);

      this._safeSend({
        type: 'response',
        requestId,
        status: result.status,
        data: result.data,
        headers: result.headers
      });
    } catch (err) {
      console.error(`[WS-Client] Error handling request ${requestId}:`, err.message);
      this._safeSend({
        type: 'response',
        requestId,
        error: err.message
      });
    }
  }

  /**
   * Перенаправляем запрос на локальный Express-сервер через HTTP
   */
  _forwardToLocal(urlPath, body, responseType) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body);

      const options = {
        hostname: '127.0.0.1',
        port: this.localPort,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          let data;

          if (responseType === 'arraybuffer') {
            // Для бинарных данных — отправляем как base64
            data = buffer.toString('base64');
          } else {
            // Для JSON — парсим
            try {
              data = JSON.parse(buffer.toString());
            } catch {
              data = buffer.toString();
            }
          }

          resolve({
            status: res.statusCode,
            data,
            headers: res.headers
          });
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.setTimeout(55000, () => {
        req.destroy(new Error('Local request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Переподключение с exponential backoff + jitter
   */
  _scheduleReconnect() {
    if (!this.shouldReconnect) {
      console.log('[WS-Client] Reconnection disabled (auth failure or manual disconnect)');
      return;
    }

    // Предотвращаем несколько таймеров реконнекта
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
    }

    // Jitter ±20% чтобы не все клиенты реконнектились одновременно
    const jitter = this.reconnectDelay * (0.8 + Math.random() * 0.4);
    const delay = Math.min(jitter, this.maxReconnectDelay);

    console.log(`[WS-Client] Reconnecting in ${(delay / 1000).toFixed(1)}s...`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, delay);
  }

  /**
   * Отключиться (без реконнекта)
   */
  disconnect() {
    this.shouldReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._cleanup();
  }
}

module.exports = WSClient;
