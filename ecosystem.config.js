module.exports = {
  apps : [{
    name   : "crm_simple",
    script : "./crm_simple.js",
    env : {
      // URL WS-сервера (по умолчанию wss://crmapi.regionsoft.ru/ws/endpoint)
      // apikey и secretkey берутся из реестра Windows автоматически
      // WS_SERVER_URL : "wss://crmapi.regionsoft.ru/ws/endpoint"
    }
  }]
}
