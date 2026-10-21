import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import org.springframework.boot.SpringBootVersion;
import org.springframework.boot.context.config.ConfigDataEnvironmentPostProcessor;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.support.SpringApplicationJsonEnvironmentPostProcessor;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

/** 실제 배포 설정과 backend DTO를 바인딩한다. 서버·DB·AWS 연결은 만들지 않는다. */
public class OidcConfigFixture {
    private static void check(boolean condition, String label) {
        if (!condition) throw new AssertionError(label + " 검증 실패");
    }

    private static Object property(Object dto, String getter) throws Exception {
        return dto.getClass().getMethod(getter).invoke(dto);
    }

    private static Object bind(StandardEnvironment env, String prefix, String className) throws Exception {
        return Binder.get(env).bind(prefix, Bindable.of(Class.forName(
            "com.team376.pulsemetry.enrollment.auth." + className))).get();
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        check("4.1.0".equals(SpringBootVersion.getVersion()), "Spring Boot 버전");
        StandardEnvironment env = new StandardEnvironment();
        new SpringApplicationJsonEnvironmentPostProcessor().postProcessEnvironment(env, null);
        env.getPropertySources().addFirst(new MapPropertySource("fixture-location", Map.of(
            "spring.config.location", Path.of(args[0]).toUri().toString()
        )));
        ConfigDataEnvironmentPostProcessor.applyTo(env);

        Object oidc = bind(env, "pulsemetry.oidc", "OidcProperties");
        Map<String, String> secrets = (Map<String, String>) property(oidc, "getClientSecrets");
        check(secrets.keySet().equals(Set.of("cognito-a", "Cognito_B")), "OIDC map key 보존");
        check(System.getenv("FIXTURE_EXPECT_COGNITO_A").equals(secrets.get("cognito-a")), "OIDC A 값 보존");
        check(System.getenv("FIXTURE_EXPECT_COGNITO_B").equals(secrets.get("Cognito_B")), "OIDC B 값 보존");
        check(Boolean.TRUE.equals(property(oidc, "getEnabled")), "OIDC 활성화");
        check(System.getenv("FIXTURE_EXPECT_CALLBACK").equals(property(oidc, "getCallbackBaseUrl")), "OIDC callback");
        String failureRedirect = System.getenv("FIXTURE_EXPECT_FAILURE_REDIRECT");
        check(failureRedirect.equals(property(oidc, "getFailureRedirectUri")), "OIDC 실패 복귀 주소");
        check("fixture-oidc".equals(property(oidc, "getCallbackRegistrationId")), "OIDC registration ID");
        check(Boolean.valueOf(System.getenv("FIXTURE_EXPECT_ALLOW_INSECURE_LOCALHOST"))
            .equals(property(oidc, "getAllowInsecureLocalhost")), "localhost 예외 값");

        Object auth = bind(env, "pulsemetry.user-auth", "UserAuthProperties");
        Map<String, String> publicKeys = (Map<String, String>) property(auth, "getPublicKeyFiles");
        check("/mnt/user-jwt/keys/release-2026-10.pem".equals(publicKeys.get("release-2026.10")), "기존 JWT map 보존");
        check(Set.of(failureRedirect).equals(property(auth, "getAllowedRedirectUris")), "허용 복귀 주소");
        check("release-2026.10".equals(property(auth, "getActiveKid")), "JWT active kid 보존");
        System.out.println(args[1] + ": 실제 backend DTO·localhost 예외·OIDC map/placeholder·JWT map 동시 binding PASS");
    }
}
