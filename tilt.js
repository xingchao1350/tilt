"use strict";

const Bleacon = require('bleacon');
const Gpio = require('onoff').Gpio;

const config = require('./config');
const dataParser = require('./dataParser');
const db = require('./influxHandler');
const {buttonEvent} = require('./helpers');


const button = new Gpio(config.BUTTON_PIN, 'in', 'rising', { debounceTimeout: config.BUTTON_DEBOUNCE_MS });
const led = new Gpio(config.LED_PIN, 'out');

let specificGravityAtStart = null;


const ledOn = () => led.writeSync(1)
const ledOff = () => led.writeSync(0)

const ledBlink = (interval=config.LED_BLINK_INTERVAL_MS, duration=config.LED_BLINK_DURATION_MS) => {
  // (https://github.com/fivdi/onoff#blink-an-led-using-the-synchronous-api)
  const blinkInterval = setInterval( () => {
    led.writeSync(led.readSync() === 0 ? 1 : 0);
  }, interval);

  setTimeout( () => {
    clearInterval(blinkInterval);
    ledOff();
  }, duration);
}


const setInitialLedStatus = async () => {
  const lastStartTime = await db.queryLastStartTime();
  console.log(`isFermentationRunning: ${Boolean(lastStartTime)}  ${lastStartTime ? lastStartTime : ''}`);
  if (!lastStartTime) return false;

  const specificGravity = await db.querySpecificGravity(lastStartTime);
  console.log(`specificGravity: ${specificGravity}`);
  if (!specificGravity) return false;
  specificGravityAtStart = specificGravity;

  ledOn();
}


(async () => {
  console.log('Tilt client started');
  db.createDatabase();
  setInitialLedStatus();
  Bleacon.startScanning();


  Bleacon.on('discover', function (bleacon) {
    if (bleacon.uuid == config.TILT_RED_UUID) {
      const temperature = dataParser.temperatureCelsius(bleacon);
      const specificGravity = dataParser.specificGravity(bleacon);
      const alcoholByVolume = dataParser.alcoholByVolume(specificGravityAtStart, specificGravity);
      const alcoholByMass = dataParser.alcoholByMass(alcoholByVolume);

      const data = [
        {
          variable: 'temperature',
          value: temperature,
          unit: '°C',
        },
        {
          variable: 'specific_gravity',
          value: specificGravity,
          unit: '-',
        },
        {
          variable: 'alcohol_by_volume',
          value: alcoholByVolume,
          unit: 'vol.-%',
        },
        {
          variable: 'alcohol_by_mass',
          value: alcoholByMass,
          unit: 'wt.-%',
        }
      ]

      const filteredData = data.filter(x => x.value !== null);
      console.log('Received data');
      db.writeData(filteredData);
    }
  })


  button.watch(async (err, value) => {
    if (err) {
      console.log(err);
    }

    console.log('Button was pressed.');

    const lastStartTime = await db.queryLastStartTime();
    console.log(`isFermentationRunning: ${Boolean(lastStartTime)}  ${lastStartTime ? lastStartTime : ''}`);

    const event = buttonEvent(lastStartTime);
    console.log(`buttonEvent (${event.title})`);

    if (lastStartTime)
    {
      // fermentation should be stopped
      db.writeEvent(event);
      ledOff();
    }
    else
    {
      // fermentation should be started
      const specificGravity = await db.querySpecificGravity();
      console.log(`specificGravity: ${specificGravity}`);

      if (specificGravity)
      {
        // start fermentation if specificGravity is valid
        specificGravityAtStart = specificGravity;
        db.writeEvent(event);
        ledOn();
      }
      else {
        // unable to start fermentation due to invalid specificGravity
        console.log('Unable to start fermentation (no value for `specificGravity`)');
        ledBlink();
      }
    }
  })


  process.on('SIGINT', () => {
    Bleacon.stopScanning();
    led.unexport();
    button.unexport();
  });

})();
