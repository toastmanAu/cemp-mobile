# frozen_string_literal: true

# add-image-codec.rb — one-shot project mutation for the CempImageCodec
# native module and its XCTest suite (sibling of add-kdf-targets.rb).
#
#   - adds apps/android/ios/CempImageCodec/** (RCT bridge module + the
#     React-free engine) to the CempMobile app target
#   - adds the engine + CempMobileTests/CempImageCodecTests.m to the
#     CempMobileTests target
#   - links ImageIO / CoreGraphics / MobileCoreServices into both targets
#
# Run once from the ios directory: ruby scripts/add-image-codec.rb
#
# Requires the xcodeproj gem. It ships with CocoaPods on macOS; on Linux
# install it standalone with `gem install --user-install xcodeproj`, then put
# `$(ruby -e 'puts Gem.user_dir')/bin` on PATH.
# The resulting project.pbxproj changes are committed; this script does NOT
# run in CI. It aborts if the module is already wired in.

require 'xcodeproj'

IOS_DIR = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(IOS_DIR, 'CempMobile.xcodeproj')
FRAMEWORKS = %w[ImageIO CoreGraphics MobileCoreServices].freeze

project = Xcodeproj::Project.open(PROJECT_PATH)

app_target = project.targets.find { |t| t.name == 'CempMobile' } or
  abort('CempMobile target not found')
test_target = project.targets.find { |t| t.name == 'CempMobileTests' } or
  abort('CempMobileTests target not found — run add-kdf-targets.rb first')
if app_target.source_build_phase.files_references.any? { |f| f.display_name == 'CempImageCodec.m' }
  abort('CempImageCodec already wired into CempMobile — refusing to re-apply')
end

codec_group = project.main_group.new_group('CempImageCodec', 'CempImageCodec')
tests_group = project.main_group.children.find { |g| g.display_name == 'CempMobileTests' } or
  abort('CempMobileTests group not found')

# --- App target: bridge module + engine ------------------------------------
['CempImageCodec.m', 'CempImageCodecEngine.m'].each do |rel|
  app_target.source_build_phase.add_file_reference(codec_group.new_file(rel))
end
codec_group.new_file('CempImageCodecEngine.h')

# --- Test target: engine + test suite (React-free on purpose) ---------------
test_target.source_build_phase.add_file_reference(
  tests_group.new_file('../CempImageCodec/CempImageCodecEngine.m')
)
test_target.source_build_phase.add_file_reference(
  tests_group.new_file('CempImageCodecTests.m')
)

# --- Frameworks --------------------------------------------------------------
[app_target, test_target].each do |target|
  FRAMEWORKS.each { |fw| target.add_system_framework(fw) }
end

project.save

puts 'Added CempImageCodec sources to target CempMobile'
puts 'Added engine + CempImageCodecTests.m to target CempMobileTests'
puts "Linked #{FRAMEWORKS.join(', ')} into both targets"
