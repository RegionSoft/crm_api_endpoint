// CRM Simple Endpoint - простой сервер для работы с Firebird
// Этот сервер предоставляет API для работы с Firebird, включая выполнение SQL-запросов и генерацию PDF-отчетов.
// Также реализована система загрузки файлов с использованием UploadJobManager

const express = require('express');
const bodyParser = require('body-parser');
const Firebird = require('node-firebird');
const Promise = require('bluebird');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const UploadJobManager = require('./upload_job_manager'); // Импортируем UploadJobManager
const WSClient = require('./ws_client'); // WebSocket клиент для подключения к crm_api

const app = express();
app.use(bodyParser.json());

let uploadJobManager = null;

async function initializeFileUploadSystem() {
  try {
    uploadJobManager = new UploadJobManager();
    await uploadJobManager.initialize();
    uploadJobManager.startPolling();
    console.log('File upload system initialized successfully');
  } catch (error) {
    console.error('Failed to initialize file upload system:', error);
  }
}

/**
 * Получает конфигурацию хранения (storageLocation и storageCatalog) из таблицы PARAM в Firebird.
 * @param {Object} options - объект с параметрами подключения к Firebird (host, port, database, user, password, и т.п.)
 * @returns {Promise<Object>} - промис, который резолвится объектом вида { storageLocation, storageCatalog }
 */
function getStorageConfigFromFirebird(options) {
  return new Promise((resolve, reject) => {
    Firebird.attach(options, (err, db) => {
      if (err) {
        return reject(err);
      }
      const sql = "SELECT PARAM, VAL FROM PARAM WHERE UPPER(TRIM(PARAM)) IN ('FILESTORAGELOCATION','FILESTORAGECATALOG')";
      db.query(sql, (err, result) => {
        if (err) {
          console.error("Ошибка выполнения запроса:", err);
          db.detach();
          return reject(err);
        }
        // Значения по умолчанию:
        let config = { storageLocation: 1, storageCatalog: '' };
        
/*         if (result && result.length > 0) {
          result.forEach(row => {
            const key = String(row.param).trim().toUpperCase();
            if (key === 'FILESTORAGELOCATION') {
              // Преобразуем в целое число; если преобразование не удалось – оставляем 1
              const val = parseInt(String(row.val).trim(), 10);
              config.storageLocation = isNaN(val) ? 1 : val;
            } else if (key === 'FILESTORAGECATALOG') {
              config.storageCatalog = String(row.val).trim();
            }
          });
        } */
        
        db.detach();
        resolve(config);
      });
    });
  });
}

// Основной API endpoint для выполнения SQL запросов
app.post('/api/dbase/query', (req, res) => {
  const { type, token, sql, params, client__db_host, client__db_port, client__db_path } = req.body;
  
  const options = {
    host: client__db_host, // или ваш хост
    port: client__db_port,        // или ваш порт
    database: client__db_path, // путь к файлу базы данных
    user: 'SYSDBA',      // ваш пользователь
    password: 'masterkey', // ваш пароль
    lowercase_keys: true, // установите true, если требуется преобразование ключей в нижний регистр
    role: null,          // опционально
    pageSize: 4096,       // размер страницы для базы данных
    blobAsText: true
  };
  
  console.log('Executing SQL:', sql);
  
  Firebird.attach(options, function (err, db) {
    if (err) {
      console.error('Database connection failed:', err);
      return res.status(500).send({ error: 'Database connection failed', details: err.message });
    }

    Promise.promisifyAll(db);

    db.queryAsync(sql, params || [])
      .then(result => {
        db.detach();
        if (result) { 
          res.status(200).json(result);
        } else { 
          res.status(200).json([]);
        }
      })
      .catch(error => {
        db.detach();
        console.error('Query execution failed:', error);
        res.status(500).json({ error: 'Query execution failed', details: error.message });
      });
  });
});

// Новый эндпоинт для генерации PDF
app.post('/api/generate-pdf', (req, res) => {
  const { token, client__db_host, client__db_port, client__db_path, reportName, id } = req.body;

  // Путь к базе данных
  const dbPath = client__db_host + '/' + client__db_port + ':' + client__db_path;
  
  // Валидация входных параметров
  if (!dbPath || !reportName || !id) {
    return res.status(400).json({ error: 'Missing parameters: dbPath, reportName, id are required.' });
  }

  // Путь к Delphi-программе
  const delphiExePath = path.join(__dirname, 'genpdf.exe'); // Убедитесь, что genpdf.exe находится в той же директории

  // Проверка существования Delphi-программы
  if (!fs.existsSync(delphiExePath)) {
    return res.status(500).json({ error: 'PDF generator not found on server.' });
  }

  // Запуск Delphi-программы с параметрами
  const delphiProcess = spawn(delphiExePath, [dbPath, reportName, id]);

  let stdoutData = '';
  let stderrData = '';

  // Захват данных из stdout
  delphiProcess.stdout.on('data', (data) => {
    stdoutData += data.toString();
  });

  // Захват данных из stderr
  delphiProcess.stderr.on('data', (data) => {
    stderrData += data.toString();
  });

  // Обработка завершения процесса
  delphiProcess.on('close', (code) => {
    if (code !== 0) {
      console.error(`Delphi process exited with code ${code}`);
      console.error(`Stderr: ${stderrData}`);
      return res.status(500).json({ error: 'Error generating PDF.', details: stderrData });
    }

    if (!stdoutData) {
      console.error('No data received from Delphi process.');
      return res.status(500).json({ error: 'No data received from PDF generator.' });
    }

    // Предполагается, что stdoutData содержит Base64 строку PDF
    let pdfBase64 = stdoutData.trim();

    // уберем символы переноса строки
    pdfBase64 = pdfBase64.replace(/[\r\n]/g, '');
    // уберем символы переноса строки windows
    pdfBase64 = pdfBase64.replace(/\r/g, '');

    // Опционально: можно добавить проверку корректности Base64 строки
    if (!/^[a-zA-Z0-9/+=]+$/.test(pdfBase64)) {
      console.error('Invalid Base64 string received from Delphi process.');
      return res.status(500).json({ error: 'Invalid Base64 string received from PDF generator.' });
    }

    res.status(200).json({ pdf: pdfBase64 });
  });

  // Обработка ошибок запуска процесса
  delphiProcess.on('error', (err) => {
    console.error('Failed to start Delphi process:', err);
    res.status(500).json({ error: 'Failed to start PDF generator.', details: err.message });
  });
});

/**
 * Endpoint для получения файла из Firebird
 */
app.post('/api/dbase/get-file', async (req, res) => {
  const { token, fileId, client__db_host, client__db_port, client__db_path } = req.body;

  // Параметры подключения к Firebird
  const fbOptions = {
    host: client__db_host,
    port: client__db_port,
    database: client__db_path,
    user: 'SYSDBA',
    password: 'masterkey',
    lowercase_keys: true,
    role: null,
    pageSize: 4096,
    blobAsText: false
  };

  try {
    // Получаем конфигурацию хранения
    const storageConfig = await getStorageConfigFromFirebird(fbOptions);
    console.log("Storage config:", storageConfig);

    if (storageConfig.storageLocation === 2 && storageConfig.storageCatalog) {
      // Режим "catalog": извлекаем данные о файле из таблицы FILES
      Firebird.attach(fbOptions, (err, db) => {
        if (err) {
          console.error("Database connection failed:", err);
          return res.status(500).json({ error: 'Database connection failed', details: err.message });
        }
        
        const sql = "SELECT FILE_NAME, CUSTNO FROM FILES WHERE ID = ?";
        db.query(sql, [fileId], (err, result) => {
          if (err) {
            db.detach();
            console.error("Query execution failed:", err);
            return res.status(500).json({ error: 'Query execution failed', details: err.message });
          }
          
          if (!result || result.length === 0) {
            db.detach();
            return res.status(404).json({ error: 'File not found in database' });
          }
          
          const fileRecord = result[0];
          const dbFileName = fileRecord.file_name;
          const custNo = fileRecord.custno;
          db.detach();

          // Формируем путь к файлу в каталоге
          const sourcePath = path.join(
            storageConfig.storageCatalog,
            "FILES",
            String(custNo),
            `${fileId}_${dbFileName}`
          );
          
          console.log(`Catalog mode: reading file from ${sourcePath}`);
          
          fs.access(sourcePath, fs.constants.R_OK, (err) => {
            if (err) {
              console.error("File not found in catalog:", err);
              return res.status(404).json({ error: 'File not found in catalog', details: err.message });
            }
            
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(dbFileName)}`);
            res.setHeader('Content-Type', 'application/octet-stream');
            
            const readStream = fs.createReadStream(sourcePath);
            readStream.on('error', (streamErr) => {
              console.error("Error reading file from catalog:", streamErr);
              res.status(500).json({ error: 'Error reading file from catalog', details: streamErr.message });
            });
            readStream.pipe(res);
          });
        });
      });
    } else {
      // Режим "database": извлекаем файл из BLOB
      console.log(`Database mode: getting file with ID=${fileId} from database ${client__db_path}`);
      
      Firebird.attach(fbOptions, (err, db) => {
        if (err) {
          console.error("Database connection failed:", err);
          return res.status(500).json({ error: 'Database connection failed', details: err.message });
        }
        
        const sql = "SELECT FILE_NAME, FILE_BODY FROM FILES WHERE ID = ?";
        db.query(sql, [fileId], (err, result) => {
          if (err) {
            db.detach();
            console.error("Query execution failed:", err);
            return res.status(500).json({ error: 'Query execution failed', details: err.message });
          }
          
          if (!result || result.length === 0) {
            db.detach();
            return res.status(404).json({ error: 'File not found in database' });
          }

          const fileRecord = result[0];
          const fileName = fileRecord.file_name;
          const fileBody = fileRecord.file_body;

          // Если fileBody является функцией, читаем BLOB асинхронно
          if (typeof fileBody === 'function') {
            fileBody(function (blobErr, blobName, blobStream) {
              if (blobErr) {
                db.detach();
                console.error("Error reading BLOB:", blobErr);
                return res.status(500).json({ error: 'Error reading BLOB', details: blobErr.message });
              }

              let chunks = [];
              blobStream.on('data', function (chunk) {
                chunks.push(chunk);
              });
              
              blobStream.on('end', function () {
                const blobData = Buffer.concat(chunks);
                db.detach();
                res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
                res.setHeader('Content-Type', 'application/octet-stream');
                res.send(blobData);
              });
              
              blobStream.on('error', function (streamErr) {
                db.detach();
                console.error("Error in BLOB stream:", streamErr);
                return res.status(500).json({ error: 'Error in BLOB stream', details: streamErr.message });
              });
            });
          } else {
            // Если fileBody уже является Buffer или другим типом, отправляем напрямую
            db.detach();
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.send(fileBody);
          }
        });
      });
    }
  } catch (error) {
    console.error("Error getting storage config:", error);
    return res.status(500).json({ error: 'Error getting storage config', details: error.message });
  }
});

/**
 * Инициализация WebSocket-подключений к crm_api серверу.
 * apikey и secretkey берутся из реестра Windows (как в UploadJobManager).
 * WS_SERVER_URL берётся из env (по умолчанию wss://crmapi.regionsoft.ru/ws/endpoint).
 * Для каждой пары apikey/secretkey в реестре создаётся отдельное WS-соединение.
 */
const wsClients = [];

async function initializeWSClient() {
  const serverUrl = process.env.WS_SERVER_URL || 'wss://crmapi.regionsoft.ru/ws/endpoint';

  let Registry;
  try {
    Registry = require('winreg');
  } catch (e) {
    console.log('[WS] winreg not available (not Windows?) — skipping WS client init');
    return;
  }

  try {
    // Читаем apikeys из реестра
    const apikeyReg = new Registry({
      hive: Registry.HKLM,
      key: '\\SOFTWARE\\RegionSoft\\CRM_API\\apikeys'
    });

    const apikeys = await new Promise((resolve, reject) => {
      apikeyReg.values((err, items) => {
        if (err) reject(err);
        else resolve(items);
      });
    });

    console.log(`[WS] Found ${apikeys.length} API keys in registry`);

    for (const item of apikeys) {
      try {
        const id = item.name;
        const apikey = item.value;

        // Получаем secretkey для этого id
        const secretkeyReg = new Registry({
          hive: Registry.HKLM,
          key: '\\SOFTWARE\\RegionSoft\\CRM_API\\secretkeys'
        });

        const secretkey = await new Promise((resolve, reject) => {
          secretkeyReg.get(id, (err, regItem) => {
            if (err) reject(err);
            else resolve(regItem.value);
          });
        });

        if (!secretkey) {
          console.error(`[WS] No secret key for ${id}, skipping`);
          continue;
        }

        const client = new WSClient({
          serverUrl,
          apikey,
          secretkey,
          localPort: PORT
        });

        client.connect();
        wsClients.push(client);
        console.log(`[WS] Client initialized for key ${id}, connecting to ${serverUrl}`);
      } catch (err) {
        console.error(`[WS] Failed to init client for key ${item.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[WS] Failed to read registry:', err.message);
  }
}

// Тестовый endpoint
app.get('/test', (req, res) => {
  res.status(200).send('OK');
});

const PORT = 3061;
app.listen(PORT, () => {
  initializeFileUploadSystem().catch(error => {
    console.error('Error initializing file upload system:', error);
  });

  // Запускаем WS-клиент для подключения к crm_api (если настроен)
  initializeWSClient();

  console.log(`Server running on port ${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');

  // Stop the upload job manager
  if (uploadJobManager) {
    uploadJobManager.stopPolling();
  }

  // Отключаем все WS-клиенты
  for (const client of wsClients) {
    client.disconnect();
  }

  process.exit(0);
});