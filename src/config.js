const path = require('path');
const fs = require('fs-extra');

class Config {
  constructor() {
    this.configPath = path.join(__dirname, '../data/config.json');
    this.defaultConfig = {
      database: {
        type: 'mongodb',
        mongodb: {
          host: '127.0.0.1',
          port: 27017,
          database: 'videonow',
          username: '',
          password: '',
          authSource: 'admin',
          ssl: false,
          connectionString: '' // 如果有自定義連線字串
        }
      },
      app: {
        theme: 'light',
        language: 'zh-TW'
      }
    };
  }

  async init() {
    await fs.ensureDir(path.dirname(this.configPath));

    if (!await fs.pathExists(this.configPath)) {
      await this.save(this.defaultConfig);
    }
  }

  async load() {
    try {
      if (await fs.pathExists(this.configPath)) {
        const configData = await fs.readJson(this.configPath);
        return { ...this.defaultConfig, ...configData };
      }
      return this.defaultConfig;
    } catch (error) {
      console.error('載入配置檔案失敗:', error);
      return this.defaultConfig;
    }
  }

  async save(config) {
    try {
      await fs.writeJson(this.configPath, config, { spaces: 2 });
      return true;
    } catch (error) {
      console.error('儲存配置檔案失敗:', error);
      return false;
    }
  }

  async updateDatabaseConfig(databaseConfig) {
    const config = await this.load();
    config.database = { ...config.database, ...databaseConfig };
    return await this.save(config);
  }

  async getDatabaseConfig() {
    const config = await this.load();
    return config.database;
  }

  async setDatabaseType(type) {
    const config = await this.load();
    config.database.type = type;
    return await this.save(config);
  }

  async getMongoDBConnectionString() {
    const config = await this.load();
    const mongodb = config.database.mongodb;

    if (mongodb.connectionString) {
      return mongodb.connectionString;
    }

    let connectionString = 'mongodb://';

    if (mongodb.username && mongodb.password) {
      connectionString += `${encodeURIComponent(mongodb.username)}:${encodeURIComponent(mongodb.password)}@`;
    }

    connectionString += `${mongodb.host}:${mongodb.port}/${mongodb.database}`;

    const params = [];
    if (mongodb.authSource && mongodb.username) {
      params.push(`authSource=${mongodb.authSource}`);
    }
    if (mongodb.ssl) {
      params.push('ssl=true');
    }

    if (params.length > 0) {
      connectionString += '?' + params.join('&');
    }

    return connectionString;
  }

  async testMongoDBConnection() {
    try {
      const { MongoClient } = require('mongodb');
      const connectionString = await this.getMongoDBConnectionString();

      const client = new MongoClient(connectionString, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000
      });

      await client.connect();
      await client.db().admin().ping();
      await client.close();

      return { success: true, message: '連線成功' };
    } catch (error) {
      return {
        success: false,
        message: error.message || '連線失敗'
      };
    }
  }

  getConfigPath() {
    return this.configPath;
  }
}

module.exports = Config;