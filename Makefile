include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for Geomate
LUCI_DEPENDS:=+geomate +luci-base
LUCI_PKGARCH:=all

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
