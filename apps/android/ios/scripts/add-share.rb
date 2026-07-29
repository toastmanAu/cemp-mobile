# frozen_string_literal: true

# add-share.rb — one-shot project mutation for the CempShare native module
# (sibling of add-kdf-targets.rb, add-image-codec.rb, add-image-picker.rb,
# add-bgtask.rb).
#
#   - adds apps/android/ios/CempShare/CempShare.m (RCT bridge module) to the
#     CempMobile app target. No engine/test split and no CempMobileTests
#     wiring here — CempShare is a thin UIActivityViewController shell with
#     no React-free logic worth XCTest coverage (unlike the other modules).
#     UIKit is already linked into CempMobile by default.
#
# Run once from the ios directory (requires the xcodeproj gem, which ships
# with CocoaPods):  ruby scripts/add-share.rb
# The resulting project.pbxproj change is committed; this script does NOT
# run in CI. It aborts if the module is already wired in.

require 'xcodeproj'

IOS_DIR = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(IOS_DIR, 'CempMobile.xcodeproj')

project = Xcodeproj::Project.open(PROJECT_PATH)

app_target = project.targets.find { |t| t.name == 'CempMobile' } or
  abort('CempMobile target not found')
if app_target.source_build_phase.files_references.any? { |f| f.display_name == 'CempShare.m' }
  abort('CempShare already wired into CempMobile — refusing to re-apply')
end

share_group = project.main_group.new_group('CempShare', 'CempShare')

# --- App target: bridge module ----------------------------------------------
app_target.source_build_phase.add_file_reference(share_group.new_file('CempShare.m'))

project.save

puts 'Added CempShare sources to target CempMobile'
