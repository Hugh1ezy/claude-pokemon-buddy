// PCF85063 real-time clock, on the same I2C bus as the SHTC3 and the ES8311
// (SDA 13 / SCL 14 on this board), backed by the 18650.
//
// The device's own clock lives in RAM and is set by the host's T_TIME frame, so
// it does not survive a reboot. That is fine while a host is around and is not
// fine for anything the device has to do alone: offline 亲密度 attributes a KEY
// press to an HOUR, and with no clock there is no honest hour to attribute it
// to. This chip is what closes that.
//
// Deliberately a narrow interface. The chip can do alarms, timers, a 1Hz
// interrupt on GPIO 15 and a byte of battery-backed RAM; none of that is wired
// up, and adding it should be a decision rather than a side effect.

#ifndef PCF85063_H
#define PCF85063_H

#include <stdint.h>

#include "shtc3.h"   // I2cMasterBus

class Pcf85063 {
public:
    explicit Pcf85063(I2cMasterBus &bus);

    // Wall clock as the rest of the firmware speaks it: hour/minute plus days
    // since 1970-01-01 counted off the LOCAL calendar date, which is exactly
    // what the host's T_TIME carries and what the ganzhi table indexes by.
    //
    // Returns false on a bus error and, importantly, also when the chip's
    // oscillator-stop flag is set -- that flag means the backup rail dropped
    // and whatever is in the registers is not a time. Absent, not guessed.
    bool read(uint8_t *hour, uint8_t *minute, uint16_t *epoch_day);

    // Sets the clock and clears the oscillator-stop flag. Seconds are zeroed:
    // T_TIME carries no seconds, so there are none to preserve, and the error
    // that introduces is bounded by well under the hour these readings feed.
    bool write(uint8_t hour, uint8_t minute, uint16_t epoch_day);

    bool present() const { return dev_ != nullptr; }

private:
    bool read_regs(uint8_t reg, uint8_t *out, size_t len);
    bool write_regs(uint8_t reg, const uint8_t *in, size_t len);

    void *dev_ = nullptr;   // i2c_master_dev_handle_t, kept opaque to the header
};

#endif
