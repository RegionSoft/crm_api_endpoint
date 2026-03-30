// UploadJobManager.js - Менеджер загрузки задач для RegionSoft CRM Simple Endpoint
const Registry = require('winreg');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Firebird = require('node-firebird');
const { promisify } = require('util');

class UploadJobManager {
  constructor() {
    this.isPolling = false;
    this.databaseConfigs = [];
    this.pollInterval = 30000; // 30 seconds
    this.proxyUrl = 'https://crmapi.regionsoft.ru'; // URL прокси сервера
  }
  
  /**
   * Инициализация менеджера загрузки задач
   * Получение конфигураций баз данных из реестра Windows
   * и аутентификация с прокси-сервером
   */
  async initialize() {
    try {
      console.log('Initializing UploadJobManager...');
      
      // Доступ к ветке реестра apikeys
      const apikeyReg = new Registry({
        hive: Registry.HKLM,
        key: '\\SOFTWARE\\RegionSoft\\CRM_API\\apikeys'
      });
      
      // Получаем все записи API ключей
      const values = await new Promise((resolve, reject) => {
        apikeyReg.values((err, items) => {
          if (err) {
            console.error('Error reading registry apikeys:', err);
            reject(err);
          } else {
            resolve(items);
          }
        });
      });
      
      console.log(`Found ${values.length} API keys in registry`);
      
      // Обрабатываем каждую запись API ключа
      for (const item of values) {
        try {
          const id = item.name; 
          const apikey = item.value;
          
          console.log(`Processing API key ${id}...`);
          
          // Получаем соответствующий secretkey из реестра
          const secretkeyReg = new Registry({
            hive: Registry.HKLM,
            key: '\\SOFTWARE\\RegionSoft\\CRM_API\\secretkeys'
          });
          
          const secretkey = await new Promise((resolve, reject) => {
            secretkeyReg.get(id, (err, item) => {
              if (err) {
                console.error(`Error reading secret key for ${id}:`, err);
                reject(err);
              } else {
                resolve(item.value);
              }
            });
          });
          
          // Получаем конфигурацию базы данных
          if (!secretkey) {
            console.error(`No secret key found for ${id}`);
            continue;
          }
          
          const config = await this.authenticateWithProxy(apikey, secretkey, id);
          if (config) {
            this.databaseConfigs.push(config);
            console.log(`Loaded configuration for database ${id}: ${config.description}`);
          }
        } catch (error) {
          console.error(`Failed to load configuration for key ${item.name}:`, error);
        }
      }
      
      if (this.databaseConfigs.length === 0) {
        throw new Error('No valid database configurations found');
      }
      
      console.log(`Initialized UploadJobManager with ${this.databaseConfigs.length} databases`);
    } catch (error) {
      console.error('Failed to initialize UploadJobManager:', error);
      throw error;
    }
  }
  
  /**
   * Аутентификация с прокси-сервером и получение данных подключения к базе данных
   */
  async authenticateWithProxy(apikey, secretkey, id) {
    try {
      console.log(`Authenticating with proxy for database ${id}...`);
      
      const response = await axios.post(`${this.proxyUrl}/manage/getKey`, {
        apikey: apikey,
        secretkey: secretkey
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000
      });
      
      if (response.data && response.status === 200) {
        console.log(`Authentication successful for database ${id}`);
        return {
          apikey: apikey,
          secretkey: secretkey,
          ID: id,
          description: response.data.description,
          places: response.data.places,
          expire: new Date(response.data.expire),
          client_db_host: response.data.client_db_host,
          client_db_port: response.data.client_db_port,
          client_db_path: response.data.client_db_path
        };
      } else {
        console.error(`Invalid response from auth server for database ${id}:`, response.data);
        return null;
      }
    } catch (error) {
      console.error(`Authentication error for database ${id}:`, error.message);
      return null;
    }
  }
  
  /**
   * Запуск опроса на наличие задач загрузки
   */
  async startPolling() {
    if (this.isPolling) {
      console.log('Already polling for upload jobs');
      return;
    }
    
    this.isPolling = true;
    console.log('Started polling for upload jobs');
    
    // Запускаем цикл опроса
    const pollCycle = async () => {
      if (!this.isPolling) return;
      
      try {
        await this.pollForJobs();
      } catch (error) {
        console.error('Error in job polling cycle:', error);
      }
      
      // Задержка перед следующим опросом
      if (this.isPolling) {
        setTimeout(pollCycle, this.pollInterval);
      }
    };
    
    // Начинаем цикл опроса
    pollCycle();
  }
  
  /**
   * Остановка опроса
   */
  stopPolling() {
    this.isPolling = false;
    console.log('Stopped polling for upload jobs');
  }
  
  /**
   * Опрос задач загрузки
   */
  async pollForJobs() {
    console.log('Polling for jobs...');
    
    for (const config of this.databaseConfigs) {
      try {
        // Получаем список ожидающих задач
        const pendingJobs = await this.getPendingJobs(config);
        
        if (pendingJobs.length > 0) {
          console.log(`Found ${pendingJobs.length} pending jobs for database ${config.ID}`);
          
          // Обрабатываем каждую задачу
          for (const job of pendingJobs) {
            try {
              console.log(`Processing job ${job.jobId} for database ${config.ID}`);
              await this.processJob(job, config);
            } catch (jobError) {
              console.error(`Error processing job ${job.jobId}:`, jobError);
            }
          }
        }
      } catch (error) {
        console.error(`Error polling jobs for database ${config.ID}:`, error);
      }
    }
  }
  
  /**
   * Получение списка ожидающих задач загрузки
   */
  async getPendingJobs(config) {
    try {
      const response = await axios.post(`${this.proxyUrl}/api/pending-upload-jobs`, {
        apikey: config.apikey,
        secretkey: config.secretkey
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000
      });
      
      if (response.data && response.data.result === 'ok') {
        return response.data.jobs || [];
      } else {
        console.error('Invalid response from job server:', response.data);
        return [];
      }
    } catch (error) {
      console.error('Error fetching pending jobs:', error.message);
      return [];
    }
  }
  
  /**
   * Обработка задачи загрузки
   */
  async processJob(job, config) {
    console.log(`Processing job ${job.jobId} for database ${config.ID}`);
    
    let tempFilePath = null;
    
    try {
      // Download the file
      const fileData = await this.downloadJobFile(job.jobId, config);
      
      // Create temporary file
      const tempDir = os.tmpdir();
      tempFilePath = path.join(tempDir, `upload_${job.jobId}_${Date.now()}_${fileData.fileName}`);
      
      // Write file to disk
      await fs.promises.writeFile(tempFilePath, Buffer.from(fileData.fileBase64, 'base64'));
      console.log(`Temp file created: ${tempFilePath}, size: ${fileData.fileSize} bytes`);
      
      // Get storage configuration
      const storageConfig = await this.getStorageConfigFromFirebird(config);
      console.log(`Storage config for ${config.ID}:`, storageConfig);
      
      // Process file and insert into Firebird
      const fileId = await this.insertFileIntoFirebird(
        tempFilePath,
        fileData.fileName,
        fileData.metadata.custNo,
        fileData.metadata.folderId,
        fileData.metadata.folder,
        config,
        storageConfig
      );
      
      // Notify job completion
      await this.notifyJobComplete(job.jobId, config, true, fileId);
      
      console.log(`Successfully processed job ${job.jobId}, file ID: ${fileId}`);
    } catch (error) {
      console.error(`Error processing job ${job.jobId}:`, error);
      
      // Notify job failure
      try {
        await this.notifyJobComplete(job.jobId, config, false, null, error.message);
      } catch (notifyError) {
        console.error(`Failed to notify job failure for ${job.jobId}:`, notifyError);
      }
    } finally {
      // Clean up temporary file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          await fs.promises.unlink(tempFilePath);
          console.log(`Cleaned up temp file: ${tempFilePath}`);
        } catch (unlinkError) {
          console.error(`Failed to remove temp file ${tempFilePath}:`, unlinkError);
        }
      }
    }
  }
  
  /**
   * Скачивание файла
   */
  async downloadJobFile(jobId, config) {
    try {
      console.log(`Downloading file for job ${jobId}...`);
      
      const response = await axios.post(`${this.proxyUrl}/api/download-job-file`, {
        apikey: config.apikey,
        secretkey: config.secretkey,
        jobId: jobId
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        // Set a longer timeout for large files
        timeout: 300000 // 5 minutes
      });
      
      if (response.data && response.data.result === 'ok') {
        console.log(`File downloaded for job ${jobId}, size: ${response.data.fileSize} bytes`);
        return {
          fileBase64: response.data.fileBase64,
          fileName: response.data.fileName,
          fileSize: response.data.fileSize,
          metadata: response.data.metadata
        };
      } else {
        throw new Error(`Invalid response: ${JSON.stringify(response.data)}`);
      }
    } catch (error) {
      console.error(`Error downloading file for job ${jobId}:`, error.message);
      throw error;
    }
  }
  
  /**
   * Получение конфигурации хранилища из Firebird
   */
  async getStorageConfigFromFirebird(config) {
    return new Promise((resolve, reject) => {
      const options = {
        host: config.client_db_host,
        port: config.client_db_port,
        database: config.client_db_path,
        user: 'SYSDBA',
        password: 'masterkey',
        lowercase_keys: true
      };
      
      Firebird.attach(options, (err, db) => {
        if (err) {
          reject(err);
          return;
        }
        
        const sql = "SELECT PARAM, VAL FROM PARAM WHERE UPPER(TRIM(PARAM)) IN ('FILESTORAGELOCATION','FILESTORAGECATALOG')";
        
        db.query(sql, (queryErr, result) => {
          db.detach();
          
          if (queryErr) {
            reject(queryErr);
            return;
          }
          
          // Default values
          let storageConfig = { storageLocation: 1, storageCatalog: '' };
          
          // if (result && result.length > 0) {
          //   result.forEach(row => {
          //     const key = String(row.param).trim().toUpperCase();
          //     if (key === 'FILESTORAGELOCATION') {
          //       const val = parseInt(String(row.val).trim(), 10);
          //       storageConfig.storageLocation = isNaN(val) ? 1 : val;
          //     } else if (key === 'FILESTORAGECATALOG') {
          //       storageConfig.storageCatalog = String(row.val).trim();
          //     }
          //   });
          // }
          
          resolve(storageConfig);
        });
      });
    });
  }
  
  /**
   * Вставка файла в Firebird
   */
  async insertFileIntoFirebird(filePath, fileName, custNo, folderId, folder, config, storageConfig) {
    return new Promise((resolve, reject) => {
      const options = {
        host: config.client_db_host,
        port: config.client_db_port,
        database: config.client_db_path,
        user: 'SYSDBA',
        password: 'masterkey',
        lowercase_keys: true,
        role: null,
        pageSize: 4096,
        blobAsText: false
      };
      
      console.log(`Inserting file ${fileName} into Firebird (storage mode: ${storageConfig.storageLocation})`);
      
      Firebird.attach(options, (err, db) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Start a transaction
        db.transaction(Firebird.ISOLATION_READ_COMMITTED, (transErr, transaction) => {
          if (transErr) {
            db.detach();
            reject(transErr);
            return;
          }
          
          const fileStats = fs.statSync(filePath);
          const fileSize = fileStats.size;
          
          if (storageConfig.storageLocation === 2 && storageConfig.storageCatalog) {
            // Use catalog storage
            this.handleCatalogStorage(
              transaction,
              filePath,
              fileName,
              custNo,
              folderId,
              folder,
              fileSize,
              storageConfig
            ).then(fileId => {
              transaction.commit(commitErr => {
                db.detach();
                if (commitErr) {
                  reject(commitErr);
                } else {
                  console.log(`File inserted with ID ${fileId} (catalog mode)`);
                  resolve(fileId);
                }
              });
            }).catch(error => {
              transaction.rollback(() => {
                db.detach();
                reject(error);
              });
            });
          } else {
            // Use database BLOB storage
            this.handleDatabaseStorage(
              transaction,
              filePath,
              fileName,
              custNo,
              folderId,
              folder,
              fileSize
            ).then(fileId => {
              transaction.commit(commitErr => {
                db.detach();
                if (commitErr) {
                  reject(commitErr);
                } else {
                  console.log(`File inserted with ID ${fileId} (database mode)`);
                  resolve(fileId);
                }
              });
            }).catch(error => {
              transaction.rollback(() => {
                db.detach();
                reject(error);
              });
            });
          }
        });
      });
    });
  }
  
  /**
   * В режиме файлового каталога
   */
  async handleCatalogStorage(transaction, filePath, fileName, custNo, folderId, folder, fileSize, storageConfig) {
    return new Promise((resolve, reject) => {
      // Insert record into FILES table without BLOB data
      const insertSql = `
        INSERT INTO FILES (
          CUSTNO, FOLDER_ID, FILE_NAME, FILE_SIZE, 
          USER_CHANGE, TIME_CHANGE, FOLDER
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
        RETURNING ID
      `;
      
      transaction.query(insertSql, [
        custNo || null,
        folderId || null,
        fileName,
        fileSize,
        null, // USER_CHANGE - could be set to a specific user ID if available
        folder || null
      ], (queryErr, result) => {
        if (queryErr) {
          reject(queryErr);
          return;
        }
        
        const fileId = result[0].id;
        
        try {
          // Create directory for file storage
          const custDir = path.join(
            storageConfig.storageCatalog,
            "FILES",
            String(custNo || '0')
          );
          
          // Create directory if it doesn't exist
          if (!fs.existsSync(custDir)) {
            fs.mkdirSync(custDir, { recursive: true });
          }
          
          // Save file to catalog with name format: {fileId}_{fileName}
          const destPath = path.join(custDir, `${fileId}_${fileName}`);
          fs.copyFileSync(filePath, destPath);
          
          console.log(`File copied to catalog: ${destPath}`);
          resolve(fileId);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
  
  /**
   * В режиме базы данных
   */
  async handleDatabaseStorage(transaction, filePath, fileName, custNo, folderId, folder, fileSize) {
    return new Promise((resolve, reject) => {
      // Insert record with BLOB data
      const insertSql = `
        INSERT INTO FILES (
          CUSTNO, FOLDER_ID, FILE_NAME, FILE_BODY, FILE_SIZE, 
          USER_CHANGE, TIME_CHANGE, FOLDER
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
        RETURNING ID
      `;
      
      console.log(`Inserting file ${fileName} as BLOB, size: ${fileSize} bytes`);
      
      // node-firebird supports directly using a file for BLOB input
      transaction.query(insertSql, [
        custNo || null,
        folderId || null,
        fileName,
        { type: 'FILE', filename: filePath }, // Special syntax for BLOB from file
        fileSize,
        null, // USER_CHANGE - could be set to a specific user ID if available
        folder || null
      ], (queryErr, result) => {
        if (queryErr) {
          console.error('Error inserting file into database:', queryErr);
          reject(queryErr);
          return;
        }
        
        const fileId = result[0].id;
        resolve(fileId);
      });
    });
  }
  
  /**
   * Уведомление о завершении задачи загрузки
   */
  async notifyJobComplete(jobId, config, success, fileId, error = null) {
    try {
      console.log(`Notifying completion of job ${jobId} (success: ${success})`);
      
      await axios.post(`${this.proxyUrl}/api/complete-upload-job`, {
        apikey: config.apikey,
        secretkey: config.secretkey,
        jobId: jobId,
        success: success,
        fileId: fileId,
        error: error
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000
      });
      
      console.log(`Successfully notified completion of job ${jobId}`);
    } catch (error) {
      console.error(`Failed to notify completion of job ${jobId}:`, error.message);
      throw error;
    }
  }
}

// Export the manager class
module.exports = UploadJobManager;