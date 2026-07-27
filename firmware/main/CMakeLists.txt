idf_component_register(
    SRCS "main.cpp"
    INCLUDE_DIRS "."
    REQUIRES port_bsp esp_driver_usb_serial_jtag driver esp_timer
              esp_wifi esp_netif nvs_flash esp_event mdns esp_adc
)

# main.cpp pulls wifi_creds.h in through __has_include, which does NOT register a
# build dependency: editing credentials otherwise relinks the previous object and
# silently reflashes the old passphrase (confirmed the hard way -- the binary kept
# its CHANGE_ME placeholders after the file was created). Declaring the dependency
# here makes later edits rebuild. The guard is required because IDF also runs this
# file in script mode while expanding component requirements, where
# set_source_files_properties does not exist.
#
# Creating wifi_creds.h for the very first time still needs `idf.py reconfigure`
# (or a touch of main.cpp) -- this is evaluated at configure time.
if(NOT CMAKE_BUILD_EARLY_EXPANSION AND EXISTS "${CMAKE_CURRENT_LIST_DIR}/wifi_creds.h")
  target_compile_definitions(${COMPONENT_LIB} PRIVATE CPB_HAVE_WIFI_CREDS=1)
  set_source_files_properties(main.cpp PROPERTIES OBJECT_DEPENDS "${CMAKE_CURRENT_LIST_DIR}/wifi_creds.h")
endif()
