# frozen_string_literal: true

# add-kdf-targets.rb — one-shot project mutation for the CempKdf native
# module and its conformance test target.
#
#   - adds apps/android/ios/CempKdf/** (bridge module + C facade + vendored
#     C core) to the CempMobile app target
#   - adds a hostless unit-test target CempMobileTests compiling the same C
#     core + facade plus CempMobileTests/CempKdfTests.m, with
#     tools/kdf-c-core/vectors.txt bundled as a resource
#   - repoints the CempMobile scheme's existing CempMobileTests
#     TestableReference at the new target UUID
#
# Run once from the ios directory (requires the xcodeproj gem, which ships
# with CocoaPods):  ruby scripts/add-kdf-targets.rb
# The resulting project.pbxproj + xcscheme changes are committed; this
# script does NOT run in CI. It aborts if the test target already exists.

require 'xcodeproj'

IOS_DIR = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(IOS_DIR, 'CempMobile.xcodeproj')
SCHEME_PATH = File.join(IOS_DIR, 'CempMobile.xcodeproj', 'xcshareddata',
                        'xcschemes', 'CempMobile.xcscheme')
# Vendored C sources compiled into both targets (mirrors run-vectors.sh).
VENDOR_C = %w[
  vendor/argon2/src/argon2.c
  vendor/argon2/src/core.c
  vendor/argon2/src/encoding.c
  vendor/argon2/src/ref.c
  vendor/argon2/src/thread.c
  vendor/argon2/src/blake2/blake2b.c
  vendor/scrypt/lib/crypto/crypto_scrypt-ref.c
  vendor/scrypt/libcperciva/alg/sha256.c
  vendor/scrypt/libcperciva/util/insecure_memzero.c
].freeze
HEADER_SEARCH_PATHS = [
  '$(inherited)',
  '$(SRCROOT)/CempKdf',
  '$(SRCROOT)/CempKdf/vendor/argon2/include',
  '$(SRCROOT)/CempKdf/vendor/argon2/src',
  '$(SRCROOT)/CempKdf/vendor/scrypt/lib-platform/crypto',
  '$(SRCROOT)/CempKdf/vendor/scrypt/libcperciva/alg',
  '$(SRCROOT)/CempKdf/vendor/scrypt/libcperciva/cpusupport',
  '$(SRCROOT)/CempKdf/vendor/scrypt/libcperciva/util'
].freeze
PREPROCESSOR_DEFINITIONS = ['$(inherited)', 'ARGON2_NO_THREADS=1'].freeze

project = Xcodeproj::Project.open(PROJECT_PATH)

app_target = project.targets.find { |t| t.name == 'CempMobile' } or
  abort('CempMobile target not found')
if project.targets.any? { |t| t.name == 'CempMobileTests' }
  abort('CempMobileTests target already exists — refusing to re-apply')
end

kdf_group = project.main_group.new_group('CempKdf', 'CempKdf')
tests_group = project.main_group.new_group('CempMobileTests', 'CempMobileTests')

# --- App target: bridge module + facade + vendored C core -----------------
app_sources = ['CempKdf.m', 'CempKdfCore.c'] + VENDOR_C
app_sources.each do |rel|
  ref = kdf_group.new_file(rel)
  app_target.source_build_phase.add_file_reference(ref)
end
# Facade header + provenance note as project references (not compiled).
kdf_group.new_file('CempKdfCore.h')
kdf_group.new_file('PROVENANCE.md')

app_target.build_configurations.each do |config|
  config.build_settings['HEADER_SEARCH_PATHS'] = HEADER_SEARCH_PATHS
  config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] =
    PREPROCESSOR_DEFINITIONS
end

# --- Test target: same C core + facade + vector-driven XCTest -------------
test_target = project.new_target(:unit_test_bundle, 'CempMobileTests', :ios,
                                 '15.1')
test_target.add_system_framework('XCTest')
test_sources = ['../CempKdf/CempKdfCore.c'] +
               VENDOR_C.map { |rel| "../CempKdf/#{rel}" }
test_sources.each do |rel|
  ref = tests_group.new_file(rel)
  test_target.source_build_phase.add_file_reference(ref)
end
test_ref = tests_group.new_file('CempKdfTests.m')
test_target.source_build_phase.add_file_reference(test_ref)

# Single source of truth for the vectors: reference the file in tools/
# (path is relative to the project dir = ios/).
vectors_ref = tests_group.new_file('../../../tools/kdf-c-core/vectors.txt',
                                   'SOURCE_ROOT')
test_target.resources_build_phase.add_file_reference(vectors_ref)

test_target.build_configurations.each do |config|
  config.build_settings.merge!(
    'PRODUCT_NAME' => 'CempMobileTests',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.cempmobile.tests',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'CODE_SIGNING_ALLOWED' => 'NO',
    'CLANG_ENABLE_OBJC_ARC' => 'YES',
    'HEADER_SEARCH_PATHS' => HEADER_SEARCH_PATHS,
    'GCC_PREPROCESSOR_DEFINITIONS' => PREPROCESSOR_DEFINITIONS
  )
end

project.save

# --- Repoint the scheme's TestableReference at the new target UUID --------
scheme = File.read(SCHEME_PATH)
old_uuid = '00E356ED1AD99517003FC87E'
unless scheme.include?(old_uuid)
  abort("scheme does not reference the expected placeholder #{old_uuid}")
end
File.write(SCHEME_PATH, scheme.gsub(old_uuid, test_target.uuid))

puts "Added CempKdf sources to target CempMobile"
puts "Added unit-test target CempMobileTests (#{test_target.uuid})"
puts "Updated CempMobile.xcscheme TestableReference"
