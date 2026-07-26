# frozen_string_literal: true

# add-bgtask.rb — one-shot project mutation for the CempScheduler /
# CempHeadlessTask native modules and their XCTest suite (sibling of
# add-kdf-targets.rb, add-image-codec.rb, add-image-picker.rb).
#
#   - adds apps/android/ios/CempScheduler/** (RCT bridge modules + the
#     React-free engine) to the CempMobile app target, links BackgroundTasks
#   - sets SWIFT_OBJC_BRIDGING_HEADER so AppDelegate.swift can call
#     CempScheduler.registerBackgroundTasks
#   - adds the engine + CempMobileTests/CempSchedulerTests.m to the
#     CempMobileTests target, links BackgroundTasks
#
# Run once from the ios directory (requires the xcodeproj gem, which ships
# with CocoaPods):  ruby scripts/add-bgtask.rb
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
if app_target.source_build_phase.files_references.any? { |f| f.display_name == 'CempScheduler.m' }
  abort('CempScheduler already wired into CempMobile — refusing to re-apply')
end

scheduler_group = project.main_group.new_group('CempScheduler', 'CempScheduler')
tests_group = project.main_group.children.find { |g| g.display_name == 'CempMobileTests' } or
  abort('CempMobileTests group not found')
app_group = project.main_group.children.find { |g| g.display_name == 'CempMobile' } or
  abort('CempMobile group not found')

# --- App target: bridge modules + engine + bridging header -----------------
['CempScheduler.m', 'CempSchedulerEngine.m', 'CempHeadlessTask.m'].each do |rel|
  app_target.source_build_phase.add_file_reference(scheduler_group.new_file(rel))
end
scheduler_group.new_file('CempScheduler.h')
scheduler_group.new_file('CempSchedulerEngine.h')
app_target.add_system_framework('BackgroundTasks')

app_group.new_file('CempMobile/CempMobile-Bridging-Header.h')
app_target.build_configurations.each do |config|
  config.build_settings['SWIFT_OBJC_BRIDGING_HEADER'] =
    'CempMobile/CempMobile-Bridging-Header.h'
end

# --- Test target: engine + test suite (React-free on purpose) ---------------
test_target.source_build_phase.add_file_reference(
  tests_group.new_file('../CempScheduler/CempSchedulerEngine.m')
)
test_target.source_build_phase.add_file_reference(
  tests_group.new_file('CempSchedulerTests.m')
)
test_target.add_system_framework('BackgroundTasks')

project.save

puts 'Added CempScheduler/CempHeadlessTask sources to target CempMobile (+ BackgroundTasks)'
puts 'Set SWIFT_OBJC_BRIDGING_HEADER on CempMobile'
puts 'Added engine + CempSchedulerTests.m to target CempMobileTests (+ BackgroundTasks)'
