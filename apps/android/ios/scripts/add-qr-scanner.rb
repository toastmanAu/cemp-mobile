# frozen_string_literal: true

# add-qr-scanner.rb — one-shot project mutation for the CempQrScanner native
# module (sibling of add-share.rb, add-image-picker.rb, add-image-codec.rb).
#
#   - adds apps/android/ios/CempQrScanner/{CempQrScanner.m,
#     CempQrScannerViewController.m} to the CempMobile app target
#     (CempQrScannerViewController.h is added as a project reference only —
#     headers are not compiled)
#   - links AVFoundation / Vision / CoreImage into the app target
#   - No CempMobileTests wiring: like CempShare, this module is a thin
#     Vision/AVFoundation UI shell with no React-free logic worth XCTest
#     coverage.
#
# Run once from the ios directory: ruby scripts/add-qr-scanner.rb
#
# Requires the xcodeproj gem. It ships with CocoaPods on macOS; on Linux
# install it standalone with `gem install --user-install xcodeproj`, then put
# `$(ruby -e 'puts Gem.user_dir')/bin` on PATH.
# The resulting project.pbxproj change is committed; this script does NOT
# run in CI. It aborts if the module is already wired in.

require 'xcodeproj'

IOS_DIR = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(IOS_DIR, 'CempMobile.xcodeproj')
FRAMEWORKS = %w[AVFoundation Vision CoreImage].freeze

project = Xcodeproj::Project.open(PROJECT_PATH)

app_target = project.targets.find { |t| t.name == 'CempMobile' } or
  abort('CempMobile target not found')
if app_target.source_build_phase.files_references.any? { |f| f.display_name == 'CempQrScanner.m' }
  abort('CempQrScanner already wired into CempMobile — refusing to re-apply')
end

scanner_group = project.main_group.new_group('CempQrScanner', 'CempQrScanner')

# --- App target: bridge module + camera view controller ---------------------
['CempQrScanner.m', 'CempQrScannerViewController.m'].each do |rel|
  app_target.source_build_phase.add_file_reference(scanner_group.new_file(rel))
end
# Header as a project reference only (not compiled).
scanner_group.new_file('CempQrScannerViewController.h')

# --- Frameworks --------------------------------------------------------------
FRAMEWORKS.each { |fw| app_target.add_system_framework(fw) }

project.save

puts 'Added CempQrScanner sources to target CempMobile'
puts "Linked #{FRAMEWORKS.join(', ')} into target CempMobile"
