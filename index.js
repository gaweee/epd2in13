const rpio = require('rpio');
const spi = require('spi-device');
const { Image } = require('image-js');

// Resolution
const DEVICE_WIDTH = 212;
const DEVICE_HEIGHT = 104;

let RST_PIN = 11; // 17 BCM
let DC_PIN = 22; // 25 BCM
let CS_PIN = 24; // 8 BCM
let BUSY_PIN = 18; // 24 BCM

class epd2in13 {
	constructor(config) {
		this.gpio = rpio;
		this.spi = false;

		if (config.RST_PIN) RST_PIN = config.RST_PIN;
		if (config.RST_PIN) DC_PIN = config.DC_PIN;
		if (config.RST_PIN) CS_PIN = config.CS_PIN;
		if (config.RST_PIN) BUSY_PIN = config.BUSY_PIN;

		this.width = DEVICE_WIDTH;
		this.height = DEVICE_HEIGHT;
	}

	async reset() {
		this.gpio.write(RST_PIN, 1);
		this.gpio.msleep(200);
		this.gpio.write(RST_PIN, 0);
		this.gpio.msleep(2);
		this.gpio.write(RST_PIN, 1);
		this.gpio.msleep(200);
	}

	send_buffer(sendBuffer) {
		return new Promise((resolve, reject) => {
			this.spi.transfer(
				[{
                    sendBuffer,
                    byteLength: sendBuffer.byteLength,
                    speedHz: 2000000, // 2Mhz first
				}],
				(err, message) => {
					if (err) reject(err);
					resolve();
				}
			);
		});
	}

	async send_data(data) {
		this.gpio.write(DC_PIN, 1);
		this.gpio.write(CS_PIN, 0);
		await this.send_buffer(Buffer.isBuffer(data) ? data : Buffer.from([data]));
		this.gpio.write(CS_PIN, 1);
	}

	async send_command(data) {
		this.gpio.write(DC_PIN, 0);
		this.gpio.write(CS_PIN, 0);
		await this.send_buffer(Buffer.isBuffer(data) ? data : Buffer.from([data]));
		this.gpio.write(CS_PIN, 1);
	}

	async readBusy() {
		console.log('e-Paper busy');
		while (this.gpio.read(BUSY_PIN) == 0)
			this.gpio.msleep(100);

		console.log('e-Paper busy release');
	}

	async init() {
		rpio.init({ mapping: 'physical' });
		rpio.open(RST_PIN, rpio.OUTPUT);
		rpio.open(DC_PIN, rpio.OUTPUT);
		rpio.open(CS_PIN, rpio.OUTPUT);
		rpio.open(BUSY_PIN, rpio.INPUT);

		this.spi = spi.openSync(0, 0, { maxSpeedHz: 400000 });

		// EPD hardware init start
		await this.reset();

		await this.send_command(0x06); // BOOSTER_SOFT_START
		await this.send_data(0x17);
		await this.send_data(0x17);
		await this.send_data(0x17);

		await this.send_command(0x04); // POWER_ON
		await this.readBusy();

		await this.send_command(0x00); // PANEL_SETTING
		await this.send_data(0x8f);

		await this.send_command(0x50); // VCOM_AND_DATA_INTERVAL_SETTING
		await this.send_data(0xf0);

		await this.send_command(0x61); // RESOLUTION_SETTING
		await this.send_data(DEVICE_HEIGHT & 0xff);
		await this.send_data(DEVICE_WIDTH >> 8);
		await this.send_data(DEVICE_WIDTH & 0xff);
	}

	async display(black = [], red = []) {
		await this.send_command(0x10);
		for (let i = 0; i < Math.trunc((DEVICE_WIDTH * DEVICE_HEIGHT) / 8) && i < black.length; i++)
            await this.send_data(black[i]);
		// await this.send_command(0x92); // No idea what this does, nothing bad happens when i take it out

		await this.send_command(0x13);
		for (let i = 0; i < Math.trunc((DEVICE_WIDTH * DEVICE_HEIGHT) / 8) && i < red.length; i++)
            await this.send_data(red[i]);
		// this.send_command(0x92);

		await this.send_command(0x12); // REFRESH
		this.gpio.msleep(100);

		await this.readBusy();
	}

	async prepareCanvas(canvas) {
		const image = Image.fromCanvas(canvas);
		return this.prepareImageBuffer(image);
	}

	async prepareImageFile(path) {
		return Image.load(path).then(this.prepareImageBuffer);
	}

	async prepareImageBuffer(image) {
		image = image.grey({ algorithm: 'minimum' }).resize({ width: DEVICE_WIDTH, height: DEVICE_HEIGHT });
		if (image.width > image.height) image = image.rotate(90).resize(DEVICE_HEIGHT, DEVICE_WIDTH); // Change final orientation to be portrait (thats how the silly e-paper wants it)

		const output = Buffer.alloc(Math.trunc((DEVICE_WIDTH * DEVICE_HEIGHT) / 8), 0xff); // Every pixel is made of 1 bits, organized into 8-bit blocks.

		/**
		 * Width swaps with height due to orientation of pixels
		 * The epaper takes the bottom left pixels the moves to top left
		 * Thus even if the image is rotated correctly "EPD_WIDTH" now maps to the image height
		 * */
		for (let y = 0; y < DEVICE_WIDTH && y < image.height; y++) {
			for (let x = 0; x < DEVICE_HEIGHT && x < image.width; x++) {
				const [r, g, b] = image.getPixelXY(x, y);
				const pos = y * Math.min(DEVICE_WIDTH, image.width) + x;
				const cursor = Math.trunc(pos / 8);
				if (r < 128) output[cursor] &= ~(0x80 >> x % 8);
			}
		}

		return output;
	}

	async clear(color = 0xff) {
		return await this.display(Buffer.alloc(Math.trunc((DEVICE_WIDTH * DEVICE_HEIGHT) / 8), color), Buffer.alloc(Math.trunc((DEVICE_WIDTH * DEVICE_HEIGHT) / 8), color));
	}

	async wait(duration = 1000) {
		this.gpio.msleep(duration);
	}

	async sleep() {
		await this.send_command(0x02);
		await this.readBusy();
		await this.send_command(0x07); // DEEP_SLEEP
		await this.send_data(0xa5); // Check code

		await this.gpio.msleep(2000);

		console.log('spi end');
		this.spi.closeSync();

		console.log('close 5V, Module enters 0 power consumption ...');
		this.gpio.write(RST_PIN, 0);
		this.gpio.write(DC_PIN, 0);
		console.log('Pins shutdown');
	}
}

module.exports = epd2in13;
