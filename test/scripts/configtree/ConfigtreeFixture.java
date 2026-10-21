import java.nio.file.Path;
import java.util.Map;
import org.springframework.boot.SpringBootVersion;
import org.springframework.boot.context.config.ConfigDataEnvironmentPostProcessor;
import org.springframework.boot.context.config.ConfigDataLocationNotFoundException;
import org.springframework.boot.context.config.ConfigDataResourceNotFoundException;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

/** 실제 Boot config data와 backend Kotlin DTO만 로딩한다. 서버·자동설정·외부 접속은 없다. */
public class ConfigtreeFixture {
    public record Datasource(String url, String username, String password) {}

    private static void check(boolean condition, String label) {
        if (!condition) throw new AssertionError(label + " 검증 실패");
    }

    private static Object property(Object dto, String getter) throws Exception {
        return dto.getClass().getMethod(getter).invoke(dto);
    }

    public static void main(String[] args) throws Exception {
        check("4.1.0".equals(SpringBootVersion.getVersion()), "Spring Boot 버전");
        String workload = args[0];
        StandardEnvironment env = new StandardEnvironment();
        env.getPropertySources().addFirst(new MapPropertySource("fixture-location", Map.of(
            "spring.config.location", Path.of(args[1]).toUri().toString()
        )));
        if ("missing-directory".equals(args[2])) {
            try {
                ConfigDataEnvironmentPostProcessor.applyTo(env);
            } catch (ConfigDataLocationNotFoundException | ConfigDataResourceNotFoundException expected) {
                System.out.println(workload + ": 필수 configtree 디렉터리 누락 거절 PASS");
                return;
            }
            throw new AssertionError("필수 configtree 디렉터리 누락을 거절하지 않았다");
        }
        ConfigDataEnvironmentPostProcessor.applyTo(env);
        String expectedUser = System.getenv("FIXTURE_EXPECT_USERNAME");
        String expectedPassword = System.getenv("FIXTURE_EXPECT_PASSWORD");
        String expectedHash = System.getenv("FIXTURE_EXPECT_HASH");
        check(expectedUser.equals(env.getProperty("spring.datasource.username")), "YAML DB username placeholder");
        check(expectedPassword.equals(env.getProperty("spring.datasource.password")), "YAML DB password placeholder");
        check(expectedHash.equals(env.getProperty("pulsemetry.token-hash-secret")), "YAML HMAC placeholder");
        Datasource datasource = Binder.get(env).bind("spring.datasource", Bindable.of(Datasource.class)).get();
        check(expectedUser.equals(datasource.username()), "datasource DTO username");
        check(expectedPassword.equals(datasource.password()), "datasource DTO password");

        String dtoClass = "enrollment-api".equals(workload)
            ? "com.team376.pulsemetry.enrollment.config.PulsemetryProperties"
            : "com.team376.pulsemetry.telemetry.config.TelemetryIngestProperties";
        Object dto = Binder.get(env).bind("pulsemetry", Bindable.of(Class.forName(dtoClass))).get();
        check(expectedHash.equals(property(dto, "getTokenHashSecret")), "backend Kotlin DTO HMAC");
        if ("enrollment-api".equals(workload)) {
            Object admin = property(dto, "getAdmin");
            check(System.getenv("FIXTURE_EXPECT_ADMIN").equals(property(admin, "getApiToken")), "backend Kotlin DTO admin token");
        } else {
            check(env.getProperty("PULSEMETRY_ADMIN_API_TOKEN") == null, "ingest 관리자 token 부재");
            Object archive = property(property(dto, "getTelemetry"), "getArchive");
            check("eks_validation".equals(property(archive, "getBasePrefix")), "backend Kotlin DTO archive prefix");
            check("fixture-archive".equals(property(archive, "getBucket")), "backend Kotlin DTO archive bucket");
        }
        System.out.println(workload + ": YAML placeholder·실제 Kotlin DTO binding·" + args[2] + " PASS");
    }
}
