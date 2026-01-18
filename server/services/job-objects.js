const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Windows Job Object wrapper using PowerShell and native Windows APIs
class WindowsJobObject {
  constructor() {
    this.jobName = null;
    this.processPids = new Set();
  }

  /**
   * Create a new Job Object using PowerShell
   */
  async create(jobName) {
    this.jobName = jobName;

    const script = `
      try {
        # Create Job Object using kernel32.dll
        $signature = @"
        using System;
        using System.Runtime.InteropServices;
        public class JobObject {
          [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
          public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
          
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern bool SetInformationJobObject(IntPtr hJob, uint JobObjectInfoClass, 
            IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
            
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
          
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern bool CloseHandle(IntPtr hObject);
          
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern IntPtr GetCurrentProcess();
          
          public const int JobObjectExtendedLimitInformation = 9;
          public const int JobObjectCpuRateControlInformation = 15;
          
          [StructLayout(LayoutKind.Sequential, Pack=8)]
          public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            public long BasicLimitInformation;
            public long IoLimitFlags;
            public long IoMinimumReadOperationCount;
            public long IoMaximumReadOperationCount;
            public long IoMinimumWriteOperationCount;
            public long IoMaximumWriteOperationCount;
            public long PerJobUserTimeLimit;
            public long PerProcessUserTimeLimit;
            public long MinimumWorkingSetSize;
            public long MaximumWorkingSetSize;
            public long ActiveProcessLimit;
            public long Affinity;
            public long PriorityClass;
            public long SchedulingClass;
            public long JobMemoryLimit;
            public long PeakProcessMemoryUsed;
          }
          
          [StructLayout(LayoutKind.Sequential)]
          public struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
            public uint ControlFlags;
            public uint CpuRate;
            public uint PenaltyRate;
          }
          
          public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
          public const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x800;
          public const uint JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
        }
"@
        
        Add-Type -TypeDefinition $signature
        
        $hJob = [JobObject]::CreateJobObject([IntPtr]::Zero, "${jobName}")
        if ($hJob -eq [IntPtr]::Zero) {
          throw "Failed to create job object"
        }
        
        # Set KILL_ON_JOB_CLOSE so all processes terminate when job is closed
        $basicLimits = New-Object System.Int64
        $basicLimits = $basicLimits -bor [JobObject]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        
        $extendedInfo = New-Object JobObject+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        $extendedInfo.BasicLimitInformation = $basicLimits
        $extendedInfo.JobMemoryLimit = 0
        $extendedInfo.ActiveProcessLimit = 0
        
        $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([System.Runtime.InteropServices.Marshal]::SizeOf($extendedInfo))
        try {
          [System.Runtime.InteropServices.Marshal]::StructureToPtr($extendedInfo, $ptr, $false)
          $success = [JobObject]::SetInformationJobObject($hJob, [JobObject]::JobObjectExtendedLimitInformation, $ptr, [System.Runtime.InteropServices.Marshal]::SizeOf($extendedInfo))
          if (-not $success) {
            throw "Failed to set job limits"
          }
        } finally {
          [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
        }
        
        Write-Output "SUCCESS: Job created"
      } catch {
        Write-Error $_.Exception.Message
        exit 1
      }
    `;

    try {
      await this.runPowershell(script);
      console.log(`[JOB_OBJECT] Created job object for: ${jobName}`);
      return true;
    } catch (error) {
      console.warn(`[JOB_OBJECT] Warning: Failed to create or configure job object ${jobName}. Process isolation might be limited.`, error.message);
      // We return true anyway to let the server start proceed, as job objects are a best-effort isolation layer.
      return true;
    }
  }

  /**
   * Set CPU limit for the job (percentage of total CPU)
   */
  async setCpuLimit(cpuPercent) {
    if (!this.jobName) {
      throw new Error('Job object not created');
    }

    const script = `
      try {
        $signature = @"
        using System;
        using System.Runtime.InteropServices;
        public class JobObjectCpu {
          [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
          public static extern IntPtr OpenJobObject(uint dwDesiredAccess, bool bInheritHandle, string lpName);
          
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern bool SetInformationJobObject(IntPtr hJob, uint JobObjectInfoClass, 
            IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
            
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern bool CloseHandle(IntPtr hObject);
          
          public const int JobObjectCpuRateControlInformation = 15;
          public const uint JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
          
          [StructLayout(LayoutKind.Sequential)]
          public struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
            public uint ControlFlags;
            public uint CpuRate;
            public uint PenaltyRate;
          }
        }
"@
        
        Add-Type -TypeDefinition $signature
        
        $hJob = [JobObjectCpu]::OpenJobObject(0x203F, $false, "${this.jobName}") # JOB_OBJECT_ALL_ACCESS
        if ($hJob -eq [IntPtr]::Zero) {
          throw "Failed to open job object"
        }
        
        try {
          $cpuInfo = New-Object JobObjectCpu+JOBOBJECT_CPU_RATE_CONTROL_INFORMATION
          $cpuInfo.ControlFlags = [JobObjectCpu]::JOB_OBJECT_CPU_RATE_CONTROL_ENABLE
          $cpuInfo.CpuRate = [uint](${cpuPercent} * 10000)  # Convert to 0.01% units
          $cpuInfo.PenaltyRate = 0
          
          $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([System.Runtime.InteropServices.Marshal]::SizeOf($cpuInfo))
          try {
            [System.Runtime.InteropServices.Marshal]::StructureToPtr($cpuInfo, $ptr, $false)
            $success = [JobObjectCpu]::SetInformationJobObject($hJob, [JobObjectCpu]::JobObjectCpuRateControlInformation, $ptr, [System.Runtime.InteropServices.Marshal]::SizeOf($cpuInfo))
            if (-not $success) {
              throw "Failed to set CPU limit"
            }
          } finally {
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
          }
        } finally {
          [JobObjectCpu]::CloseHandle($hJob)
        }
        
        Write-Output "SUCCESS: CPU limit set"
      } catch {
        Write-Error $_.Exception.Message
        exit 1
      }
    `;

    try {
      await this.runPowershell(script);
      console.log(`[JOB_OBJECT] Set CPU limit: ${cpuPercent}%`);
    } catch (error) {
      console.error(`[JOB_OBJECT] Failed to set CPU limit:`, error);
      throw error;
    }
  }

  /**
   * Set memory limit for the job (in MB)
   */
  async setMemoryLimit(memoryMB) {
    if (!this.jobName) {
      throw new Error('Job object not created');
    }

    const script = `
      try {
        $signature = @"
        using System;
        using System.Runtime.InteropServices;
        public class JobObjectMem {
          [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
          public static extern IntPtr OpenJobObject(uint dwDesiredAccess, bool bInheritHandle, string lpName);
          
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern bool SetInformationJobObject(IntPtr hJob, uint JobObjectInfoClass, 
            IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
            
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern bool CloseHandle(IntPtr hObject);
          
          public const int JobObjectExtendedLimitInformation = 9;
          public const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x800;
          
          [StructLayout(LayoutKind.Sequential, Pack=8)]
          public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            public long BasicLimitInformation;
            public long IoLimitFlags;
            public long IoMinimumReadOperationCount;
            public long IoMaximumReadOperationCount;
            public long IoMinimumWriteOperationCount;
            public long IoMaximumWriteOperationCount;
            public long PerJobUserTimeLimit;
            public long PerProcessUserTimeLimit;
            public long MinimumWorkingSetSize;
            public long MaximumWorkingSetSize;
            public long ActiveProcessLimit;
            public long Affinity;
            public long PriorityClass;
            public long SchedulingClass;
            public long JobMemoryLimit;
            public long PeakProcessMemoryUsed;
          }
        }
"@
        
        Add-Type -TypeDefinition $signature
        
        $hJob = [JobObjectMem]::OpenJobObject(0x203F, $false, "${this.jobName}") # JOB_OBJECT_ALL_ACCESS
        if ($hJob -eq [IntPtr]::Zero) {
          throw "Failed to open job object"
        }
        
        try {
          $extendedInfo = New-Object JobObjectMem+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
          $extendedInfo.BasicLimitInformation = [JobObjectMem]::JOB_OBJECT_LIMIT_JOB_MEMORY
          $extendedInfo.JobMemoryLimit = [int64]${memoryMB} * 1024 * 1024
          $extendedInfo.ActiveProcessLimit = 0
          
          $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([System.Runtime.InteropServices.Marshal]::SizeOf($extendedInfo))
          try {
            [System.Runtime.InteropServices.Marshal]::StructureToPtr($extendedInfo, $ptr, $false)
            $success = [JobObjectMem]::SetInformationJobObject($hJob, [JobObjectMem]::JobObjectExtendedLimitInformation, $ptr, [System.Runtime.InteropServices.Marshal]::SizeOf($extendedInfo))
            if (-not $success) {
              throw "Failed to set memory limit"
            }
          } finally {
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
          }
        } finally {
          [JobObjectMem]::CloseHandle($hJob)
        }
        
        Write-Output "SUCCESS: Memory limit set"
      } catch {
        Write-Error $_.Exception.Message
        exit 1
      }
    `;

    try {
      await this.runPowershell(script);
      console.log(`[JOB_OBJECT] Set memory limit: ${memoryMB}MB`);
    } catch (error) {
      console.error(`[JOB_OBJECT] Failed to set memory limit:`, error);
      throw error;
    }
  }

  /**
   * Add a process to the job
   */
  async addProcess(pid) {
    if (!this.jobName) {
      throw new Error('Job object not created');
    }

    const script = `
      try {
        $signature = @"
        using System;
        using System.Runtime.InteropServices;
        public class JobObjectAssign {
          [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
          public static extern IntPtr OpenJobObject(uint dwDesiredAccess, bool bInheritHandle, string lpName);
          
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
            
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern bool CloseHandle(IntPtr hObject);
          
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
        }
"@
        
        Add-Type -TypeDefinition $signature
        
        $hJob = [JobObjectAssign]::OpenJobObject(0x203F, $false, "${this.jobName}") # JOB_OBJECT_ALL_ACCESS
        if ($hJob -eq [IntPtr]::Zero) {
          throw "Failed to open job object"
        }
        
        try {
          $hProcess = [JobObjectAssign]::OpenProcess(0x1F0FFF, $false, ${pid}) # PROCESS_ALL_ACCESS
          if ($hProcess -eq [IntPtr]::Zero) {
            throw "Failed to open process ${pid}"
          }
          
          try {
            $success = [JobObjectAssign]::AssignProcessToJobObject($hJob, $hProcess)
            if (-not $success) {
              throw "Failed to assign process to job"
            }
          } finally {
            [JobObjectAssign]::CloseHandle($hProcess)
          }
        } finally {
          [JobObjectAssign]::CloseHandle($hJob)
        }
        
        Write-Output "SUCCESS: Process added to job"
      } catch {
        Write-Error $_.Exception.Message
        exit 1
      }
    `;

    try {
      await this.runPowershell(script);
      this.processPids.add(pid);
      console.log(`[JOB_OBJECT] Added process PID ${pid} to job`);
    } catch (error) {
      console.error(`[JOB_OBJECT] Failed to add process ${pid}:`, error);
      throw error;
    }
  }

  /**
   * Terminate all processes in the job
   */
  async terminateAll() {
    if (!this.jobName || this.processPids.size === 0) {
      return;
    }

    // Since we set KILL_ON_JOB_CLOSE, we just need to close the job handle
    await this.close();
    console.log(`[JOB_OBJECT] Terminated all processes in job`);
  }

  /**
   * Close the job object (which will terminate all processes due to KILL_ON_JOB_CLOSE)
   */
  async close() {
    if (!this.jobName) {
      return;
    }

    const script = `
      try {
        $signature = @"
        using System;
        using System.Runtime.InteropServices;
        public class JobObjectClose {
          [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
          public static extern IntPtr OpenJobObject(uint dwDesiredAccess, bool bInheritHandle, string lpName);
          
          [DllImport("kernel32.dll", SetLastError=true)]
          public static extern bool CloseHandle(IntPtr hObject);
        }
"@
        
        Add-Type -TypeDefinition $signature
        
        $hJob = [JobObjectClose]::OpenJobObject(0x203F, $false, "${this.jobName}") # JOB_OBJECT_ALL_ACCESS
        if ($hJob -eq [IntPtr]::Zero) {
          # Job might already be closed, which is fine
          Write-Output "SUCCESS: Job already closed"
          return
        }
        
        [JobObjectClose]::CloseHandle($hJob)
        Write-Output "SUCCESS: Job closed"
      } catch {
        Write-Error $_.Exception.Message
        exit 1
      }
    `;

    try {
      await this.runPowershell(script);
      console.log(`[JOB_OBJECT] Closed job object`);
    } catch (error) {
      console.error(`[JOB_OBJECT] Failed to close job:`, error);
    } finally {
      this.jobName = null;
      this.processPids.clear();
    }
  }

  /**
   * Execute PowerShell script
   */
  runPowershell(script) {
    return new Promise((resolve, reject) => {
      // Use shell: false and pass arguments as an array to avoid cmd.exe escaping issues.
      // -NoProfile and -NonInteractive make it faster and more reliable.
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '-'
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      });

      if (script) {
        ps.stdin.write(script);
      }
      ps.stdin.end();

      let stdout = '';
      let stderr = '';

      ps.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ps.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ps.on('close', (code) => {
        if (code === 0 && (stdout.includes('SUCCESS:') || stdout.trim() === '')) {
          resolve(stdout);
        } else {
          const errMsg = stderr || stdout || `Process exited with code ${code}`;
          reject(new Error(`PowerShell failed (code ${code}): ${errMsg}`));
        }
      });

      ps.on('error', (error) => {
        reject(error);
      });
    });
  }
}

// Job Object manager for servers
class JobObjectManager {
  constructor() {
    this.jobs = new Map(); // serverId -> JobObject
  }

  /**
   * Create and configure a job object for a server
   */
  async createJobForServer(serverId, cpuLimitPercent, memoryLimitMB) {
    try {
      const jobName = `Turbonox_${serverId}`;
      const job = new WindowsJobObject();

      // Create the job
      await job.create(jobName);

      // Set limits if specified
      if (cpuLimitPercent && cpuLimitPercent > 0 && cpuLimitPercent <= 100) {
        try {
          await job.setCpuLimit(cpuLimitPercent);
        } catch (error) {
          console.warn(`[JOB_OBJECT] Could not set CPU limit for server ${serverId}:`, error.message);
        }
      }

      if (memoryLimitMB && memoryLimitMB > 0) {
        try {
          await job.setMemoryLimit(memoryLimitMB);
        } catch (error) {
          console.warn(`[JOB_OBJECT] Could not set memory limit for server ${serverId}:`, error.message);
        }
      }

      // Store the job
      this.jobs.set(serverId, job);
      console.log(`[JOB_OBJECT] Created job for server ${serverId} (CPU: ${cpuLimitPercent}%, RAM: ${memoryLimitMB}MB)`);

      return job;
    } catch (error) {
      console.error(`[JOB_OBJECT] Failed to create job for server ${serverId}:`, error);
      throw error;
    }
  }

  /**
   * Add a process to a server's job
   */
  async addProcessToServerJob(serverId, pid) {
    const job = this.jobs.get(serverId);
    if (!job) {
      console.warn(`[JOB_OBJECT] No job found for server ${serverId}`);
      return false;
    }

    try {
      await job.addProcess(pid);
      return true;
    } catch (error) {
      console.error(`[JOB_OBJECT] Failed to add process ${pid} to server ${serverId} job:`, error);
      return false;
    }
  }

  /**
   * Terminate all processes in a server's job
   */
  async terminateServerJob(serverId) {
    const job = this.jobs.get(serverId);
    if (!job) {
      return;
    }

    try {
      await job.terminateAll();
      console.log(`[JOB_OBJECT] Terminated job for server ${serverId}`);
    } catch (error) {
      console.error(`[JOB_OBJECT] Failed to terminate job for server ${serverId}:`, error);
    }
  }

  /**
   * Close and cleanup a server's job
   */
  async closeServerJob(serverId) {
    const job = this.jobs.get(serverId);
    if (!job) {
      return;
    }

    try {
      await job.close();
      this.jobs.delete(serverId);
      console.log(`[JOB_OBJECT] Closed job for server ${serverId}`);
    } catch (error) {
      console.error(`[JOB_OBJECT] Failed to close job for server ${serverId}:`, error);
      this.jobs.delete(serverId);
    }
  }

  /**
   * Get job info for debugging
   */
  getJobInfo(serverId) {
    const job = this.jobs.get(serverId);
    if (!job) {
      return null;
    }

    return {
      serverId,
      jobName: job.jobName,
      processCount: job.processPids.size,
      processes: Array.from(job.processPids)
    };
  }

  /**
   * Get all active jobs
   */
  getAllJobs() {
    const jobs = [];
    for (const [serverId, job] of this.jobs.entries()) {
      jobs.push(this.getJobInfo(serverId));
    }
    return jobs;
  }

  /**
   * Cleanup all jobs (for shutdown)
   */
  async cleanup() {
    console.log(`[JOB_OBJECT] Cleaning up ${this.jobs.size} jobs...`);

    const promises = [];
    for (const [serverId, job] of this.jobs.entries()) {
      promises.push(this.closeServerJob(serverId));
    }

    await Promise.all(promises);
    console.log(`[JOB_OBJECT] Cleanup complete`);
  }
}

// Global instance
const jobManager = new JobObjectManager();

const selftest = String(process.env.TURBONOX_SELFTEST || '').toLowerCase() === '1' || String(process.env.TURBONOX_SELFTEST || '').toLowerCase() === 'true';

if (!selftest) {
  process.on('exit', () => {
    jobManager.cleanup();
  });

  process.on('SIGINT', () => {
    jobManager.cleanup().then(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    jobManager.cleanup().then(() => process.exit(0));
  });
}

module.exports = {
  WindowsJobObject,
  JobObjectManager,
  jobManager
};
