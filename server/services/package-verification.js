const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createHash } = crypto;

/**
 * Package verification service for marketplace packages
 * Handles checksums, digital signatures, and integrity verification
 */
class PackageVerificationService {
  constructor() {
    this.supportedAlgorithms = ['sha256', 'sha384', 'sha512'];
    this.defaultAlgorithm = 'sha256';
  }

  /**
   * Calculate checksum for a file or directory
   */
  async calculateChecksum(filePath, algorithm = this.defaultAlgorithm) {
    if (!this.supportedAlgorithms.includes(algorithm)) {
      throw new Error(`Unsupported algorithm: ${algorithm}. Supported: ${this.supportedAlgorithms.join(', ')}`);
    }

    const hash = createHash(algorithm);
    
    try {
      const stat = fs.statSync(filePath);
      
      if (stat.isFile()) {
        // Calculate checksum for single file
        const fileBuffer = fs.readFileSync(filePath);
        hash.update(fileBuffer);
        return hash.digest('hex');
      } else if (stat.isDirectory()) {
        // Calculate checksum for directory (recursive)
        await this._hashDirectory(hash, filePath);
        return hash.digest('hex');
      } else {
        throw new Error('Path must be a file or directory');
      }
    } catch (error) {
      throw new Error(`Failed to calculate checksum for ${filePath}: ${error.message}`);
    }
  }

  /**
   * Hash all files in a directory recursively
   */
  async _hashDirectory(hash, dirPath) {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    
    // Sort items for consistent hashing
    items.sort((a, b) => a.name.localeCompare(b.name));
    
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      
      if (item.isFile()) {
        const fileBuffer = fs.readFileSync(fullPath);
        hash.update(fileBuffer);
      } else if (item.isDirectory()) {
        await this._hashDirectory(hash, fullPath);
      }
    }
  }

  /**
   * Verify package integrity against provided checksums
   */
  async verifyPackageIntegrity(packagePath, expectedChecksums) {
    const results = {
      valid: true,
      errors: [],
      verifiedFiles: [],
      algorithm: this.defaultAlgorithm
    };

    try {
      // Determine algorithm from expected checksums
      if (expectedChecksums.algorithm && this.supportedAlgorithms.includes(expectedChecksums.algorithm)) {
        results.algorithm = expectedChecksums.algorithm;
      }

      // Verify main package checksum
      if (expectedChecksums.package) {
        const actualChecksum = await this.calculateChecksum(packagePath, results.algorithm);
        if (actualChecksum !== expectedChecksums.package) {
          results.valid = false;
          results.errors.push(`Package checksum mismatch: expected ${expectedChecksums.package}, got ${actualChecksum}`);
        } else {
          results.verifiedFiles.push({
            path: '.',
            checksum: actualChecksum,
            algorithm: results.algorithm
          });
        }
      }

      // Verify individual file checksums if provided
      if (expectedChecksums.files && typeof expectedChecksums.files === 'object') {
        for (const [relativePath, expectedChecksum] of Object.entries(expectedChecksums.files)) {
          const fullPath = path.join(packagePath, relativePath);
          
          if (!fs.existsSync(fullPath)) {
            results.valid = false;
            results.errors.push(`Missing file: ${relativePath}`);
            continue;
          }

          try {
            const actualChecksum = await this.calculateChecksum(fullPath, results.algorithm);
            if (actualChecksum !== expectedChecksum) {
              results.valid = false;
              results.errors.push(`File checksum mismatch for ${relativePath}: expected ${expectedChecksum}, got ${actualChecksum}`);
            } else {
              results.verifiedFiles.push({
                path: relativePath,
                checksum: actualChecksum,
                algorithm: results.algorithm
              });
            }
          } catch (error) {
            results.valid = false;
            results.errors.push(`Failed to verify file ${relativePath}: ${error.message}`);
          }
        }
      }

      return results;
    } catch (error) {
      results.valid = false;
      results.errors.push(`Verification failed: ${error.message}`);
      return results;
    }
  }

  /**
   * Generate package metadata with checksums
   */
  async generatePackageMetadata(packagePath, options = {}) {
    const algorithm = options.algorithm || this.defaultAlgorithm;
    const includeFiles = options.includeFiles !== false; // Default to including file checksums
    
    const metadata = {
      version: '1.0',
      algorithm,
      timestamp: new Date().toISOString(),
      package: null,
      files: {}
    };

    try {
      // Calculate main package checksum
      metadata.package = await this.calculateChecksum(packagePath, algorithm);

      // Calculate individual file checksums if requested
      if (includeFiles) {
        await this._generateFileChecksums(packagePath, metadata.files, algorithm);
      }

      return metadata;
    } catch (error) {
      throw new Error(`Failed to generate package metadata: ${error.message}`);
    }
  }

  /**
   * Generate checksums for all files in a directory
   */
  async _generateFileChecksums(dirPath, filesObj, algorithm) {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    
    // Sort items for consistent ordering
    items.sort((a, b) => a.name.localeCompare(b.name));
    
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      const relativePath = path.relative(dirPath, fullPath);
      
      if (item.isFile()) {
        try {
          filesObj[relativePath.replace(/\\/g, '/')] = await this.calculateChecksum(fullPath, algorithm);
        } catch (error) {
          // Skip files that can't be read
          console.warn(`[PACKAGE_VERIFICATION] Skipping file ${relativePath}: ${error.message}`);
        }
      } else if (item.isDirectory()) {
        await this._generateFileChecksums(fullPath, filesObj, algorithm);
      }
    }
  }

  /**
   * Verify digital signature (placeholder for future implementation)
   * This would integrate with Windows crypto APIs or external signing tools
   */
  async verifyDigitalSignature(packagePath, signatureInfo) {
    // TODO: Implement digital signature verification
    // This could integrate with:
    // - Windows CryptoAPI
    // - OpenSSL
    // - GPG
    // - Custom signing service
    
    console.warn('[PACKAGE_VERIFICATION] Digital signature verification not yet implemented');
    
    return {
      valid: true, // Default to valid for now
      verified: false,
      signer: null,
      timestamp: null,
      errors: ['Digital signature verification not implemented']
    };
  }

  /**
   * Create a signed package manifest
   */
  async createPackageManifest(packagePath, signingOptions = {}) {
    const manifest = {
      name: path.basename(packagePath),
      version: '1.0',
      created: new Date().toISOString(),
      checksums: await this.generatePackageMetadata(packagePath, signingOptions),
      signature: null
    };

    // Add digital signature if signing options provided
    if (signingOptions.sign) {
      // TODO: Implement digital signing
      console.warn('[PACKAGE_VERIFICATION] Digital signing not yet implemented');
      manifest.signature = {
        algorithm: 'RSA-SHA256',
        keyId: signingOptions.keyId || 'unknown',
        value: null // Placeholder
      };
    }

    return manifest;
  }

  /**
   * Verify a complete package (checksums + optional signature)
   */
  async verifyPackage(packagePath, manifest) {
    const results = {
      valid: true,
      integrity: null,
      signature: null,
      errors: []
    };

    try {
      // Verify integrity (checksums)
      if (manifest.checksums) {
        results.integrity = await this.verifyPackageIntegrity(packagePath, manifest.checksums);
        if (!results.integrity.valid) {
          results.valid = false;
          results.errors.push(...results.integrity.errors);
        }
      }

      // Verify digital signature if present
      if (manifest.signature) {
        results.signature = await this.verifyDigitalSignature(packagePath, manifest.signature);
        if (!results.signature.valid) {
          results.valid = false;
          results.errors.push(...results.signature.errors);
        }
      }

      return results;
    } catch (error) {
      results.valid = false;
      results.errors.push(`Package verification failed: ${error.message}`);
      return results;
    }
  }

  /**
   * Save package manifest to file
   */
  async saveManifest(packagePath, manifest) {
    const manifestPath = path.join(packagePath, 'manifest.json');
    
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      return manifestPath;
    } catch (error) {
      throw new Error(`Failed to save manifest: ${error.message}`);
    }
  }

  /**
   * Load package manifest from file
   */
  async loadManifest(packagePath) {
    const manifestPath = path.join(packagePath, 'manifest.json');
    
    try {
      if (!fs.existsSync(manifestPath)) {
        return null;
      }
      
      const content = fs.readFileSync(manifestPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to load manifest: ${error.message}`);
    }
  }
}

// Global instance
const packageVerification = new PackageVerificationService();

module.exports = {
  PackageVerificationService,
  packageVerification
};
