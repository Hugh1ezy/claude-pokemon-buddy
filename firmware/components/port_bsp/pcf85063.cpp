#include "pcf85063.h"

#include <string.h>

#include <freertos/FreeRTOS.h>
#include <driver/i2c_master.h>
#include <esp_log.h>

static const char *TAG = "pcf85063";

static constexpr uint8_t PCF_ADDR  = 0x51;
static constexpr uint8_t REG_CTRL1 = 0x00;
static constexpr uint8_t REG_SECS  = 0x04;   // .. 0x0A years, seven consecutive
static constexpr uint8_t CTRL1_STOP  = 1 << 5;
static constexpr uint8_t CTRL1_12_24 = 1 << 1;   // 0 = 24-hour
static constexpr uint8_t SECS_OS     = 1 << 7;   // oscillator stopped: time is lost

static uint8_t from_bcd(uint8_t v) { return (uint8_t)((v >> 4) * 10 + (v & 0x0f)); }
static uint8_t to_bcd(uint8_t v)   { return (uint8_t)(((v / 10) << 4) | (v % 10)); }

// Howard Hinnant's civil-calendar algorithms. Proleptic Gregorian, exact for
// every year this device will ever see, and no libc time zone anywhere near it
// -- epoch_day here is a LOCAL calendar date count, so any timezone conversion
// would be a bug rather than a nicety.
static int32_t days_from_civil(int32_t y, uint32_t m, uint32_t d)
{
    y -= m <= 2;
    const int32_t era = (y >= 0 ? y : y - 399) / 400;
    const uint32_t yoe = (uint32_t)(y - era * 400);
    const uint32_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const uint32_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (int32_t)doe - 719468;
}

static void civil_from_days(int32_t z, int32_t *y, uint32_t *m, uint32_t *d)
{
    z += 719468;
    const int32_t era = (z >= 0 ? z : z - 146096) / 146097;
    const uint32_t doe = (uint32_t)(z - era * 146097);
    const uint32_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int32_t yy = (int32_t)yoe + era * 400;
    const uint32_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const uint32_t mp = (5 * doy + 2) / 153;
    *d = doy - (153 * mp + 2) / 5 + 1;
    *m = mp + (mp < 10 ? 3 : -9);
    *y = yy + (*m <= 2);
}

Pcf85063::Pcf85063(I2cMasterBus &bus)
{
    i2c_device_config_t cfg = {};
    cfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    cfg.device_address  = PCF_ADDR;
    cfg.scl_speed_hz    = 400000;

    i2c_master_dev_handle_t dev = nullptr;
    // Not ESP_ERROR_CHECK: a missing RTC must degrade to "no time from here",
    // exactly as it did before this class existed, rather than abort the boot.
    if (i2c_master_bus_add_device(bus.handle(), &cfg, &dev) != ESP_OK) {
        ESP_LOGW(TAG, "could not add device at 0x%02x", PCF_ADDR);
        return;
    }
    dev_ = dev;

    // Force 24-hour mode and make sure the counter is running, but touch NOTHING
    // else in Control_1. Bit 0 selects the crystal's load capacitance (7pF vs
    // 12.5pF) and is a property of the board's crystal that is not visible from
    // here; writing a flat 0x00 would silently pick one and quietly cost
    // accuracy. Read-modify-write, always.
    uint8_t ctrl1 = 0;
    if (read_regs(REG_CTRL1, &ctrl1, 1)) {
        const uint8_t want = (uint8_t)(ctrl1 & ~(CTRL1_12_24 | CTRL1_STOP));
        if (want != ctrl1) write_regs(REG_CTRL1, &want, 1);
    }
}

bool Pcf85063::read_regs(uint8_t reg, uint8_t *out, size_t len)
{
    if (!dev_) return false;
    return i2c_master_transmit_receive((i2c_master_dev_handle_t)dev_, &reg, 1, out, len,
                                       pdMS_TO_TICKS(100)) == ESP_OK;
}

bool Pcf85063::write_regs(uint8_t reg, const uint8_t *in, size_t len)
{
    if (!dev_ || len > 8) return false;
    uint8_t buf[9];
    buf[0] = reg;
    memcpy(buf + 1, in, len);
    return i2c_master_transmit((i2c_master_dev_handle_t)dev_, buf, len + 1,
                               pdMS_TO_TICKS(100)) == ESP_OK;
}

bool Pcf85063::read(uint8_t *hour, uint8_t *minute, uint16_t *epoch_day)
{
    uint8_t r[7] = { 0 };
    if (!read_regs(REG_SECS, r, sizeof(r))) return false;
    if (r[0] & SECS_OS) {
        // The backup rail dropped at some point. The registers still hold
        // digits; they are simply not the time any more.
        ESP_LOGW(TAG, "oscillator-stop flag set: time was lost");
        return false;
    }

    const uint8_t mm = from_bcd((uint8_t)(r[1] & 0x7f));
    const uint8_t hh = from_bcd((uint8_t)(r[2] & 0x3f));   // 24-hour mode, forced above
    const uint8_t day = from_bcd((uint8_t)(r[3] & 0x3f));
    const uint8_t month = from_bcd((uint8_t)(r[5] & 0x1f));
    const uint8_t year2 = from_bcd(r[6]);

    // A chip that answers but answers nonsense is worse than one that does not
    // answer, because the caller would seed a clock from it.
    if (hh > 23 || mm > 59 || day < 1 || day > 31 || month < 1 || month > 12) {
        ESP_LOGW(TAG, "implausible reading %02u:%02u %04u-%02u-%02u",
                 hh, mm, 2000 + year2, month, day);
        return false;
    }

    const int32_t days = days_from_civil(2000 + (int32_t)year2, month, day);
    if (days < 0 || days > 0xffff) return false;

    if (hour) *hour = hh;
    if (minute) *minute = mm;
    if (epoch_day) *epoch_day = (uint16_t)days;
    return true;
}

bool Pcf85063::write(uint8_t hour, uint8_t minute, uint16_t epoch_day)
{
    if (!dev_ || hour > 23 || minute > 59) return false;

    int32_t y = 0;
    uint32_t m = 0, d = 0;
    civil_from_days((int32_t)epoch_day, &y, &m, &d);
    if (y < 2000 || y > 2099) return false;   // the chip carries two year digits

    // Hold the counter while the seven registers are written, so a rollover
    // cannot land in the middle and leave, say, a new minute against an old
    // hour. Clearing STOP afterwards also resets the prescaler, which is what
    // makes the write land on a whole second.
    uint8_t ctrl1 = 0;
    if (!read_regs(REG_CTRL1, &ctrl1, 1)) return false;
    const uint8_t stopped = (uint8_t)(ctrl1 | CTRL1_STOP);
    if (!write_regs(REG_CTRL1, &stopped, 1)) return false;

    const uint8_t regs[7] = {
        0,                                          // seconds; also clears the OS flag
        to_bcd(minute),
        to_bcd(hour),
        to_bcd((uint8_t)d),
        (uint8_t)((epoch_day + 4) % 7),             // 1970-01-01 was a Thursday
        to_bcd((uint8_t)m),
        to_bcd((uint8_t)(y - 2000)),
    };
    const bool ok = write_regs(REG_SECS, regs, sizeof(regs));

    const uint8_t running = (uint8_t)(ctrl1 & ~CTRL1_STOP);
    write_regs(REG_CTRL1, &running, 1);   // restart even if the write above failed
    return ok;
}
