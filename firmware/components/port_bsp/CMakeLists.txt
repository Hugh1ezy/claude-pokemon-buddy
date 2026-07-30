idf_component_register(
    SRCS "display_bsp.cpp" "shtc3.cpp" "pcf85063.cpp" "multi_button.c" "codec_bsp.cpp"
    INCLUDE_DIRS "."
    REQUIRES driver esp_lcd esp_driver_i2c esp_timer codec_board
)
