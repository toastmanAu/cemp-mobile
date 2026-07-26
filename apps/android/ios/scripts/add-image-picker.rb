# frozen_string_literal: true

# add-image-picker.rb — one-shot project mutation for the CempImagePicker
# native module and its XCTest suite (sibling of add-kdf-targets.rb and
# add-image-codec.rb).
#
#   - adds apps/android/ios/CempImagePicker/** (RCT bridge module + the
#     React-free engine) to the CempMobile app target, links PhotosUI
#   - adds the engine + CempMobileTests/CempImagePickerTests.m to the
#     CempMobileTests target, links UIKit (the engine's UIImage fallback)
#
# Run once from the ios directory (requires the xcodeproj gem, which ships
# with CocoaPods):  ruby scripts/add-image-picker.rb
# The resulting project.pbxproj changes are committed; this script does NOT
# run in CI. It aborts if the module is already wired in.

require 'xcodeproj'

IOS_DIR = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(IOS_DIR, 'CempMobile.xcodeproj')

project = Xcodeproj::Project.open(PROJECT_PATH)

app_target = project.targets.find { |t| t.name == 'CempMobile' } or
  abort('CempMobile target not found')
test_target = project.targets.find { |t| t.name == 'CempMobileTests' } or
  abort('CempMobileTests target not found — run add-kdf-targets.rb first')
if app_target.source_build_phase.files_references.any? { |f| f.display_name == 'CempImagePicker.m' }
  abort('CempImagePicker already wired into CempMobile — refusing to re-apply')
end

picker_group = project.main_group.new_group('CempImagePicker', 'CempImagePicker')
tests_group = project.main_group.children.find { |g| g.display_name == 'CempMobileTests' } or
  abort('CempMobileTests group not found')

# --- App target: bridge module + engine ------------------------------------
['CempImagePicker.m', 'CempImagePickerEngine.m'].each do |rel|
  app_target.source_build_phase.add_file_reference(picker_group.new_file(rel))
end
picker_group.new_file('CempImagePickerEngine.h')
app_target.add_system_framework('PhotosUI')

# --- Test target: engine + test suite (React-free on purpose) ---------------
test_target.source_build_phase.add_file_reference(
  tests_group.new_file('../CempImagePicker/CempImagePickerEngine.m')
)
test_target.source_build_phase.add_file_reference(
  tests_group.new_file('CempImagePickerTests.m')
)
test_target.add_system_framework('UIKit')

project.save

puts 'Added CempImagePicker sources to target CempMobile (+ PhotosUI)'
puts 'Added engine + CempImagePickerTests.m to target CempMobileTests (+ UIKit)'
